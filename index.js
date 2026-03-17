require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const { Telegraf, Markup } = require('telegraf');

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is missing in environment variables');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// Data loading (questions.json)
// ─────────────────────────────────────────────────────────────
function loadQuestionsData() {
  try {
    const filePath = path.join(__dirname, 'questions.json');
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);

    if (!data || !Array.isArray(data.departments)) {
      console.warn('⚠️ questions.json has no "departments" array, defaulting to empty.');
      return { departments: [] };
    }
    return data;
  } catch (err) {
    console.error('❌ Failed to load questions.json:', err);
    return { departments: [] };
  }
}

// Loaded once at startup (performance)
const questionsData = loadQuestionsData();

// ─────────────────────────────────────────────────────────────
// Simple in-memory session store
// ─────────────────────────────────────────────────────────────
class SessionStore {
  constructor() {
    this.sessions = new Map(); // key: userId, value: session object
  }

  getSession(userId) {
    if (!this.sessions.has(userId)) {
      this.sessions.set(userId, {
        departmentId: null,
        chapterId: null,
        currentQuestionIndex: 0,
        score: 0,
        totalQuestions: 0,
      });
    }
    return this.sessions.get(userId);
  }

  saveSession(userId, session) {
    this.sessions.set(userId, session);
  }

  resetSession(userId) {
    this.sessions.set(userId, {
      departmentId: null,
      chapterId: null,
      currentQuestionIndex: 0,
      score: 0,
      totalQuestions: 0,
    });
  }
}

const sessionStore = new SessionStore();

// ─────────────────────────────────────────────────────────────
// Data helpers
// ─────────────────────────────────────────────────────────────
function getDepartments() {
  return questionsData.departments || [];
}

function getDepartmentById(deptId) {
  return getDepartments().find((d) => d.id === deptId);
}

function getChapterById(deptId, chapterId) {
  const dept = getDepartmentById(deptId);
  if (!dept || !Array.isArray(dept.chapters)) return null;
  return dept.chapters.find((ch) => ch.id === chapterId) || null;
}

function getQuestionsForChapter(deptId, chapterId) {
  const chapter = getChapterById(deptId, chapterId);
  if (!chapter || !Array.isArray(chapter.questions)) return [];
  return chapter.questions;
}

function getQuestion(deptId, chapterId, index) {
  const questions = getQuestionsForChapter(deptId, chapterId);
  if (index < 0 || index >= questions.length) return null;
  return questions[index];
}

// ─────────────────────────────────────────────────────────────
// Keyboard builders (all use Markup.inlineKeyboard)
// ─────────────────────────────────────────────────────────────
function buildDepartmentsKeyboard() {
  const departments = getDepartments();

  if (!departments.length) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('No departments configured', 'noop')],
    ]).reply_markup;
  }

  const rows = departments.map((dept) => {
    const text = dept.name || dept.id || 'Department';
    const callbackData = `dept:${dept.id}`;
    return [Markup.button.callback(text, callbackData)];
  });

  return Markup.inlineKeyboard(rows).reply_markup;
}

function buildChaptersKeyboard(deptId) {
  const department = getDepartmentById(deptId);
  if (!department || !Array.isArray(department.chapters) || !department.chapters.length) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('No chapters available', 'noop')],
    ]).reply_markup;
  }

  const rows = department.chapters.map((chapter) => {
    const text = chapter.name || chapter.id || 'Chapter';
    const callbackData = `chap:${deptId}:${chapter.id}`;
    return [Markup.button.callback(text, callbackData)];
  });

  return Markup.inlineKeyboard(rows).reply_markup;
}

function buildOptionsKeyboard(deptId, chapterId, questionIndex) {
  const question = getQuestion(deptId, chapterId, questionIndex);
  if (!question || !Array.isArray(question.options)) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('No options available', 'noop')],
    ]).reply_markup;
  }

  const rows = question.options.map((opt, idx) => {
    const text = opt || `Option ${idx + 1}`;
    const callbackData = `ans:${idx}`;
    return [Markup.button.callback(text, callbackData)];
  });

  return Markup.inlineKeyboard(rows).reply_markup;
}

// ─────────────────────────────────────────────────────────────
// Quiz / flow helpers
// ─────────────────────────────────────────────────────────────
async function sendQuestion(ctx, session) {
  try {
    const question = getQuestion(
      session.departmentId,
      session.chapterId,
      session.currentQuestionIndex
    );

    if (!question) {
      if (session.currentQuestionIndex === 0) {
        await ctx.reply('⚠️ No questions found in this chapter yet. Please choose another chapter.');
      } else {
        await sendScoreSummary(ctx, session);
      }
      return;
    }

    const questionNumber = session.currentQuestionIndex + 1;
    const labels = ['A', 'B', 'C', 'D'];
    let fullQuestionText = `Question ${questionNumber}/${session.totalQuestions}\n\n${question.question}\n\n`;
    
    question.options.forEach((opt, index) => {
      fullQuestionText += `<b>${labels[index]}.</b> ${opt}\n`;
    });

    const buttons = question.options.map((_, index) => {
      return Markup.button.callback(labels[index], `answer:${index}`);
    });

    await ctx.replyWithHTML(fullQuestionText, Markup.inlineKeyboard([buttons]));
  } catch (err) {
    console.error('Error in sendQuestion:', err);
    await ctx.reply('😕 Something went wrong while sending the question. Please try /start.');
  }
}

async function sendScoreSummary(ctx, session) {
  try {
    const msg = `✅ Quiz finished!\n\nYour score: ${session.score}/${session.totalQuestions}`;
    await ctx.reply(msg);
    await ctx.reply(
      'Would you like to start again?',
      {
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Restart', 'restart')],
        ]).reply_markup,
      }
    );
  } catch (err) {
    console.error('Error in sendScoreSummary:', err);
  }
}

// ─────────────────────────────────────────────────────────────
// Bot setup
// ─────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// /start
bot.start(async (ctx) => {
  try {
    if (!ctx.from) return;

    sessionStore.resetSession(ctx.from.id);

    await ctx.reply(
      '👋 Welcome to the Exit Exam Prep Bot!\n\nSelect your department:',
      { reply_markup: buildDepartmentsKeyboard() }
    );
  } catch (err) {
    console.error('Error in /start handler:', err);
    await ctx.reply('😕 Something went wrong. Please try /start again in a moment.');
  }
});

// Select department
bot.action(/^dept:/, async (ctx) => {
  try {
    if (!ctx.callbackQuery || !ctx.callbackQuery.data || !ctx.from) return;

    const [, deptId] = ctx.callbackQuery.data.split(':');
    const department = getDepartmentById(deptId);

    if (!department) {
      await ctx.answerCbQuery('Department not found');
      return;
    }

    const session = sessionStore.getSession(ctx.from.id);
    session.departmentId = deptId;
    session.chapterId = null;
    session.currentQuestionIndex = 0;
    session.score = 0;
    session.totalQuestions = 0;
    sessionStore.saveSession(ctx.from.id, session);

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `Selected: *${department.name}*\n\nNow choose a chapter:`,
      {
        parse_mode: 'Markdown',
        reply_markup: buildChaptersKeyboard(deptId),
      }
    );
  } catch (err) {
    console.error('Error in dept action:', err);
    try {
      await ctx.answerCbQuery('Something went wrong.');
    } catch (_) {}
    await ctx.reply('😕 Something went wrong while selecting the department. Please use /start and try again.');
  }
});

// Select chapter
bot.action(/^chap:/, async (ctx) => {
  try {
    if (!ctx.callbackQuery || !ctx.callbackQuery.data || !ctx.from) return;

    const [, deptId, chapterId] = ctx.callbackQuery.data.split(':');
    const chapter = getChapterById(deptId, chapterId);

    if (!chapter) {
      await ctx.answerCbQuery('Chapter not found');
      return;
    }

    const questions = getQuestionsForChapter(deptId, chapterId);
    if (!questions.length) {
      await ctx.answerCbQuery('No questions in this chapter');
      await ctx.reply('⚠️ No questions found in this chapter yet. Please choose another chapter.');
      return;
    }

    const session = sessionStore.getSession(ctx.from.id);
    session.departmentId = deptId;
    session.chapterId = chapterId;
    session.currentQuestionIndex = 0;
    session.score = 0;
    session.totalQuestions = questions.length;
    sessionStore.saveSession(ctx.from.id, session);

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `Starting quiz: *${chapter.name}*`,
      { parse_mode: 'Markdown' }
    );

    await sendQuestion(ctx, session);
  } catch (err) {
    console.error('Error in chap action:', err);
    try {
      await ctx.answerCbQuery('Something went wrong.');
    } catch (_) {}
    await ctx.reply('😕 Something went wrong while starting the quiz. Please use /start and try again.');
  }
});

// Answer question
bot.action(/^ans:/, async (ctx) => {
  try {
    if (!ctx.callbackQuery || !ctx.callbackQuery.data || !ctx.from) return;

    const session = sessionStore.getSession(ctx.from.id);
    if (!session || !session.departmentId || !session.chapterId) {
      await ctx.answerCbQuery('Session expired. Use /start');
      return;
    }

    const [, optIdxStr] = ctx.callbackQuery.data.split(':');
    const selectedIndex = parseInt(optIdxStr, 10);

    if (Number.isNaN(selectedIndex)) {
      await ctx.answerCbQuery('Invalid option');
      return;
    }

    const question = getQuestion(
      session.departmentId,
      session.chapterId,
      session.currentQuestionIndex
    );

    if (!question) {
      await ctx.answerCbQuery('No more questions.');
      await sendScoreSummary(ctx, session);
      return;
    }

    const isCorrect = selectedIndex === question.correctOptionIndex;
    if (isCorrect) session.score += 1;

    await ctx.answerCbQuery(isCorrect ? '✅ Correct!' : '❌ Wrong');

    const explanation = question.explanation || 'No explanation provided for this question.';
    const feedback = `${isCorrect ? '✅ *Correct!*' : '❌ *Wrong.*'}\n\n*Explanation:*\n${explanation}`;
    await ctx.reply(feedback, { parse_mode: 'Markdown' });

    session.currentQuestionIndex += 1;
    sessionStore.saveSession(ctx.from.id, session);

    if (session.currentQuestionIndex < session.totalQuestions) {
      await sendQuestion(ctx, session);
    } else {
      await sendScoreSummary(ctx, session);
    }
  } catch (err) {
    console.error('Error in ans action:', err);
    try {
      await ctx.answerCbQuery('Something went wrong.');
    } catch (_) {}
    await ctx.reply('😕 Something went wrong while processing your answer. Please use /start to try again.');
  }
});

// Restart
bot.action('restart', async (ctx) => {
  try {
    if (!ctx.from) return;
    sessionStore.resetSession(ctx.from.id);
    await ctx.answerCbQuery();
    await ctx.reply(
      '🔄 Quiz restarted. Select your department:',
      { reply_markup: buildDepartmentsKeyboard() }
    );
  } catch (err) {
    console.error('Error in restart action:', err);
    await ctx.reply('😕 Could not restart the quiz. Please try /start.');
  }
});

// Fallback for unused callbacks
bot.action('noop', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    console.error('Error in noop action:', err);
  }
});

// ─────────────────────────────────────────────────────────────
// Express server (optional, but good for Render/health checks)
// ─────────────────────────────────────────────────────────────
const app = express();

// Health-check route (for uptime monitors / Render)
app.get('/', (req, res) => {
  res.send('OK');
});

// Long polling (simple & reliable; you can swap to webhooks later if you want)
bot.launch()
  .then(() => console.log('🤖 Bot started with long polling'))
  .catch((err) => console.error('❌ Failed to launch bot:', err));

app.listen(PORT, () => {
  console.log(`🌐 Express server listening on port ${PORT}`);
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));