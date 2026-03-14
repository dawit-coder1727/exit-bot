require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const rawQuestionsData = require('./questions.json');
const { InMemorySessionStore } = require('./sessionStore');

// Data normalization (run once at startup)
function flattenQuestionsArray(arr) {
    if (!Array.isArray(arr)) return [];
    const flat = [];
    for (const item of arr) {
        if (!item) continue;
        if (Array.isArray(item)) {
            for (const q of item) {
                if (q && q.question && Array.isArray(q.options)) {
                    flat.push(q);
                }
            }
        } else if (item.question && Array.isArray(item.options)) {
            flat.push(item);
        }
    }
    return flat;
}

function normalizeQuestionsData(data) {
    if (!data || !Array.isArray(data.departments)) {
        return { departments: [] };
    }

    return {
        ...data,
        departments: data.departments.map((dept) => {
            if (!dept) return dept;
            const normalized = { ...dept };
            if (Array.isArray(dept.chapters)) {
                normalized.chapters = dept.chapters.map((chapter) =>
                    chapter && Array.isArray(chapter.questions)
                        ? { ...chapter, questions: flattenQuestionsArray(chapter.questions) }
                        : chapter
                );
            }
            return normalized;
        }),
    };
}

const questionsData = normalizeQuestionsData(rawQuestionsData);

const BOT_TOKEN = process.env.BOT_TOKEN;
const URL = process.env.EXTERNAL_URL; 
const PORT = process.env.PORT || 3000;

const bot = new Telegraf(BOT_TOKEN);
const sessionStore = new InMemorySessionStore();
const app = express();

// Helper functions
function getDepartments() { return questionsData.departments || []; }
function getDepartmentById(deptId) { return getDepartments().find((d) => d.id === deptId); }

function getChapterById(deptId, chapterId) {
    const dept = getDepartmentById(deptId);
    if (!dept || !dept.chapters) return null;
    return dept.chapters.find((c) => c.id === chapterId);
}

function getQuestion(deptId, chapterId, index) {
    const chapter = getChapterById(deptId, chapterId);
    if (!chapter || !Array.isArray(chapter.questions)) return null;
    return chapter.questions[index] || null;
}

function getTotalQuestions(deptId, chapterId) {
    const chapter = getChapterById(deptId, chapterId);
    if (!chapter || !Array.isArray(chapter.questions)) return 0;
    return chapter.questions.length;
}

// Keyboard Builders
function buildDepartmentsKeyboard() {
    const departments = getDepartments();
    const buttons = departments.map((dept) => Markup.button.callback(dept.name, `dept:${dept.id}`));
    return Markup.inlineKeyboard(buttons.map((b) => [b]));
}

function buildChaptersKeyboard(deptId) {
    const department = getDepartmentById(deptId);
    if (!department || !department.chapters) return Markup.inlineKeyboard([]);
    const buttons = department.chapters.map((chap) => Markup.button.callback(chap.name, `chap:${deptId}:${chap.id}`));
    return Markup.inlineKeyboard(buttons.map((b) => [b]));
}

function buildOptionsKeyboard(question) {
    const buttons = question.options.map((opt, idx) => Markup.button.callback(opt, `ans:${idx}`));
    return Markup.inlineKeyboard(buttons.map((b) => [b]));
}

async function sendQuestion(ctx, session) {
    const question = getQuestion(session.departmentId, session.chapterId, session.currentQuestionIndex);
    if (!question) return;
    const text = `Question ${session.currentQuestionIndex + 1}/${session.totalQuestions}\n\n${question.question}`;
    await ctx.reply(text, buildOptionsKeyboard(question));
}

async function sendScoreSummary(ctx, session) {
    const scoreText = `🏆 Quiz Finished!\n\nYour Score: ${session.score}/${session.totalQuestions}`;
    await ctx.reply(scoreText, Markup.inlineKeyboard([Markup.button.callback('Restart', 'restart')]));
}

// Handlers
bot.start(async (ctx) => {
    try {
        if (!ctx.from) return;
        sessionStore.resetSession(ctx.from.id);
        await ctx.reply(
            '👋 Welcome to the University Exit Exam Prep Bot!\n\nSelect your department:',
            buildDepartmentsKeyboard()
        );
    } catch (err) {
        console.error(err);
        await ctx.reply('😕 Something went wrong starting the bot. Please try /start again.');
    }
});

bot.action(/^dept:/, async (ctx) => {
    try {
        if (!ctx.callbackQuery || !ctx.callbackQuery.data || !ctx.from) return;
        const [, deptId] = ctx.callbackQuery.data.split(':');
        const department = getDepartmentById(deptId);
        if (!department) return ctx.answerCbQuery('Department not found');
        await ctx.answerCbQuery();
        await ctx.editMessageText(`Selected: *${department.name}*\nChoose a chapter:`, { parse_mode: 'Markdown', ...buildChaptersKeyboard(deptId) });
    } catch (err) { console.error(err); }
});

bot.action(/^chap:/, async (ctx) => {
    try {
        if (!ctx.callbackQuery || !ctx.callbackQuery.data || !ctx.from) return;
        const [, deptId, chapterId] = ctx.callbackQuery.data.split(':');
        const chapter = getChapterById(deptId, chapterId);
        if (!chapter) return ctx.answerCbQuery('Chapter not found');
        const session = sessionStore.getSession(ctx.from.id);
        session.departmentId = deptId;
        session.chapterId = chapterId;
        session.currentQuestionIndex = 0;
        session.score = 0;
        session.totalQuestions = getTotalQuestions(deptId, chapterId);

        if (!session.totalQuestions) {
            await ctx.answerCbQuery('No questions in this chapter yet.');
            await ctx.reply('⚠️ No questions found in this chapter yet. Please choose another chapter.');
            return;
        }

        sessionStore.saveSession(ctx.from.id, session);
        await ctx.answerCbQuery();
        await ctx.editMessageText(`Starting Quiz: *${chapter.name}*`, { parse_mode: 'Markdown' });
        await sendQuestion(ctx, session);
    } catch (err) { console.error(err); }
});

bot.action(/^ans:/, async (ctx) => {
    try {
        if (!ctx.callbackQuery || !ctx.callbackQuery.data || !ctx.from) return;
        const session = sessionStore.getSession(ctx.from.id);
        if (!session || !session.chapterId) return ctx.answerCbQuery('Session expired. Use /start');

        const [, optIdx] = ctx.callbackQuery.data.split(':');
        const selected = parseInt(optIdx, 10);
        const question = getQuestion(session.departmentId, session.chapterId, session.currentQuestionIndex);

        if (!question) {
            await sendScoreSummary(ctx, session);
            return;
        }

        const isCorrect = selected === question.correctOptionIndex;
        if (isCorrect) session.score++;
        await ctx.answerCbQuery(isCorrect ? '✅ Correct!' : '❌ Wrong');
        const explanation = question.explanation || 'No explanation provided.';
        await ctx.reply(`${isCorrect ? '✅ *Correct!*' : '❌ *Wrong.*'}\n\n*Explanation:*\n${explanation}`, { parse_mode: 'Markdown' });

        session.currentQuestionIndex++;
        sessionStore.saveSession(ctx.from.id, session);
        if (session.currentQuestionIndex < session.totalQuestions) {
            await sendQuestion(ctx, session);
        } else {
            await sendScoreSummary(ctx, session);
        }
    } catch (err) { console.error(err); }
});

bot.action('restart', async (ctx) => {
    try {
        if (!ctx.from) return;
        sessionStore.resetSession(ctx.from.id);
        await ctx.reply('Select your department:', buildDepartmentsKeyboard());
    } catch (err) { console.error(err); }
});

// Webhook and Express Setup
app.use(express.json());
app.get('/', (req, res) => res.send('OK'));

if (URL) {
    const secretPath = `/telegraf/${bot.secretPathComponent()}`;
    bot.telegram.setWebhook(`${URL}${secretPath}`);
    app.use(bot.webhookCallback(secretPath));
} else {
    bot.launch();
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));