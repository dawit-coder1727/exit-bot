// src/utils/sessionStore.js

class InMemorySessionStore {
  constructor() {
    this.sessions = new Map();
  }

  /**
   * Get or initialize a session for a given user.
   * @param {number|string} userId
   * @returns {object} session
   */
  getSession(userId) {
    if (!this.sessions.has(userId)) {
      this.sessions.set(userId, this._createEmptySession());
    }
    return this.sessions.get(userId);
  }

  /**
   * Save a session (for future MongoDB integration, this is where you'd persist).
   * @param {number|string} userId
   * @param {object} session
   */
  saveSession(userId, session) {
    this.sessions.set(userId, session);
  }

  /**
   * Reset session for a user (e.g. when starting a new quiz).
   * @param {number|string} userId
   */
  resetSession(userId) {
    this.sessions.set(userId, this._createEmptySession());
  }

  _createEmptySession() {
    return {
      departmentId: null,
      chapterId: null,
      currentQuestionIndex: 0,
      score: 0,
      totalQuestions: 0
    };
  }
}

// In the future, you can export a MongoSessionStore with the same interface.
module.exports = {
  InMemorySessionStore
};