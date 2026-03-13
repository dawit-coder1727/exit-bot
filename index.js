
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const path = require('path');
const questionsData = require('./questions.json');
const { InMemorySessionStore } = require('./sessionStore');
// ====== Basic config and setup ======
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is missing in .env');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const sessionStore = new InMemorySessionStore();

// ====== Helper functions to work with questions ======

function getDepartments() {
  return questionsData.departments || [];
}

function getDepartmentById(deptId) {
  return getDepartments().find((d) => d.id === deptId);
}

function getChapterById(deptId, chapterId) {
  const department = getDepartmentById(deptId);
  if (!department) return null;
  return department.chapters.find((c) => c.id === chapterId);
}

function getQuestion(deptId, chapterId, index) {
  const chapter = getChapterById(deptId, chapterId);
  if (!chapter) return null;
  return chapter.questions[index] || null;
}

function getTotalQuestions(deptId, chapterId) {
  const chapter = getChapterById(deptId, chapterId);
  if (!chapter) return 0;
  return chapter.questions.length;
}

// Build inline keyboards
function buildDepartmentsKeyboard() {
  const departments = getDepartments();
  const buttons = departments.map((dept) =>
    Markup.button.callback(dept.name, `dept:${dept.id}`)
  );

  // Arrange in 1-column layout
  return Markup.inlineKeyboard(buttons.map((b) => [b]));
}

function buildChaptersKeyboard(deptId) {
  const department = getDepartmentById(deptId);
  if (!department) return Markup.inlineKeyboard([]);

  const buttons = department.chapters.map((ch) =>
    Markup.button.callback(ch.name, `chap:${deptId}:${ch.id}`)
  );

  return Markup.inlineKeyboard(buttons.map((b) => [b]));
}

function buildOptionsKeyboard(question) {
  const buttons = question.options.map((opt, index) =>
    Markup.button.callback(opt, `ans:${index}`)
  );
  return Markup.inlineKeyboard(buttons.map((b) => [b]));
}

// ====== Quiz flow helpers ======

async function sendQuestion(ctx, session) {
  const question = getQuestion(session.departmentId, session.chapterId, session.currentQuestionIndex);

  if (!question) {
    await ctx.reply('No more questions available for this chapter.');
    await sendScoreSummary(ctx, session);
    return;
  }

  const questionText =
    `Question ${session.currentQuestionIndex + 1}/${session.totalQuestions}\n\n` +
    `${question.question}`;

  await ctx.reply(questionText, buildOptionsKeyboard(question));
}

async function sendScoreSummary(ctx, session) {
  const message =
    `✅ Quiz finished!\n\n` +
    `Your score: ${session.score}/${session.totalQuestions}`;

  await ctx.reply(message);

  // Optionally, offer to start over
  await ctx.reply(
    'Would you like to start again?',
Markup.inlineKeyboard([
  [Markup.button.callback('🔄 Restart', 'restart')]
])
  );
}

// ====== Command & action handlers ======

// /start command
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  sessionStore.resetSession(userId);

  const welcomeMessage =
    '👋 Welcome to the University Exit Exam Prep Bot!\n\n' +
    'Select your department to begin practicing quiz questions.';

  await ctx.reply(welcomeMessage, buildDepartmentsKeyboard());
});

// Handle department selection
bot.action(/^dept:/, async (ctx) => {
  try {
    const userId = ctx.from.id;
    const [, deptId] = ctx.callbackQuery.data.split(':');
    const department = getDepartmentById(deptId);

    if (!department) {
      await ctx.answerCbQuery('Department not found');
      return;
    }

    const session = sessionStore.getSession(userId);
    session.departmentId = deptId;
    session.chapterId = null;
    session.currentQuestionIndex = 0;
    session.score = 0;
    session.totalQuestions = 0;
    sessionStore.saveSession(userId, session);

    await ctx.answerCbQuery(`Selected: ${department.name}`);

    await ctx.editMessageText(
      `You selected *${department.name}*.\nNow choose a chapter:`,
      {
        parse_mode: 'Markdown',
        ...buildChaptersKeyboard(deptId)
      }
    );
  } catch (err) {
    console.error(err);
  }
});

// Handle chapter selection
bot.action(/^chap:/, async (ctx) => {
  try {
    const userId = ctx.from.id;
    const [, deptId, chapterId] = ctx.callbackQuery.data.split(':');
    const department = getDepartmentById(deptId);
    const chapter = getChapterById(deptId, chapterId);

    if (!department || !chapter) {
      await ctx.answerCbQuery('Chapter not found');
      return;
    }

    const session = sessionStore.getSession(userId);
    session.departmentId = deptId;
    session.chapterId = chapterId;
    session.currentQuestionIndex = 0;
    session.score = 0;
    session.totalQuestions = getTotalQuestions(deptId, chapterId);
    sessionStore.saveSession(userId, session);

    await ctx.answerCbQuery(`Chapter: ${chapter.name}`);

    await ctx.editMessageText(
      `Department: *${department.name}*\nChapter: *${chapter.name}*\n\nLet's start the quiz!`,
      { parse_mode: 'Markdown' }
    );

    await sendQuestion(ctx, session);
  } catch (err) {
    console.error(err);
  }
});

// Handle answer selection
bot.action(/^ans:/, async (ctx) => {
  try {
    const userId = ctx.from.id;
    const session = sessionStore.getSession(userId);

    if (!session.departmentId || !session.chapterId) {
      await ctx.answerCbQuery('Please start a quiz first using /start');
      return;
    }

    const [, optionIndexStr] = ctx.callbackQuery.data.split(':');
    const selectedIndex = parseInt(optionIndexStr, 10);

    const question = getQuestion(
      session.departmentId,
      session.chapterId,
      session.currentQuestionIndex
    );

    if (!question) {
      await ctx.answerCbQuery('No question found.');
      return;
    }

    const isCorrect = selectedIndex === question.correctOptionIndex;

    if (isCorrect) {
      session.score += 1;
      await ctx.answerCbQuery('✅ Correct!');
    } else {
      await ctx.answerCbQuery('❌ Wrong');
    }

    // Update session
    session.currentQuestionIndex += 1;
    sessionStore.saveSession(userId, session);

    // Remove old keyboard
    try {
      await ctx.editMessageReplyMarkup(); // clears inline keyboard
    } catch (e) {
      // ignore if message already edited
    }

    // Send explanation and next question / summary
    const explanationMessage =
      `${isCorrect ? '✅ Correct!' : '❌ Wrong.'}\n\n` +
      `*Explanation:*\n${question.explanation}`;

    await ctx.reply(explanationMessage, { parse_mode: 'Markdown' });

    if (session.currentQuestionIndex < session.totalQuestions) {
      await sendQuestion(ctx, session);
    } else {
      await sendScoreSummary(ctx, session);
    }
  } catch (err) {
    console.error(err);
  }
});

// Restart quiz quickly
bot.action('restart', async (ctx) => {
  const userId = ctx.from.id;
  sessionStore.resetSession(userId);
  await ctx.answerCbQuery('Restarting...');
  await ctx.reply(
    'Please select your department again to restart the quiz.',
    buildDepartmentsKeyboard()
  );
});

// Fallback text handler (optional)
bot.on('text', async (ctx) => {
  await ctx.reply(
    'Use /start to begin the quiz and then choose your department and chapter.'
  );
});
const http = require('http');

const port = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is running');
}).listen(port);

console.log(`Server is running on port ${port}`);
// ====== Start bot ======
bot.launch().then(() => {
  console.log('🤖 Bot is running...');
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
const http = require('http');
http.createServer((req, res) => {
  res.write('Bot is live!');
  res.end();
}).listen(process.env.PORT || 3000);

console.log("Port listener added!");