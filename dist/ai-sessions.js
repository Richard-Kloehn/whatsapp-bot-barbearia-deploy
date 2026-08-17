"use strict";
/**
 * Gerencia sessões de conversa por número de telefone.
 * Sessões expiram após 15 minutos de inatividade.
 */
const sessions = new Map();
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

function getSession(phone) {
    const s = sessions.get(phone);
    if (s && Date.now() - s.lastActivity.getTime() < SESSION_TIMEOUT_MS) {
        s.lastActivity = new Date();
        return s;
    }
    const nova = { messages: [], lastActivity: new Date() };
    sessions.set(phone, nova);
    return nova;
}

function saveSession(phone, messages) {
    const s = sessions.get(phone) ?? { messages: [], lastActivity: new Date() };
    s.messages = messages.slice(-30);
    s.lastActivity = new Date();
    sessions.set(phone, s);
}

// Limpeza de sessões expiradas a cada 10 minutos
setInterval(() => {
    const now = Date.now();
    for (const [phone, session] of sessions.entries()) {
        if (now - session.lastActivity.getTime() > SESSION_TIMEOUT_MS) {
            sessions.delete(phone);
        }
    }
}, 10 * 60 * 1000);

module.exports = { getSession, saveSession };
