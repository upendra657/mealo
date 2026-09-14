/**
 * Conversation state and context assembly.
 *
 * The token budget decides the design here. Groq's free tier allows 8,000
 * tokens per minute, and a reasoning model can spend that on a single turn. So
 * history is never replayed: the last few turns go verbatim, everything older
 * is compressed into one rolling summary, and the state slice is rebuilt fresh
 * each turn rather than accumulated.
 *
 * The other constraint is P2 — what crosses the network is a de-identified
 * slice. That is enforced here and in domain/state.ts, at the point the payload
 * is built, not by asking a model to be discreet.
 */

import { scopedDb, type Agent } from '../db/scope';
import { activeProfile } from '../lib/active-profile';
import { chat } from './adapter';
import type { ChatMessage, ProviderConfig } from './types';

/**
 * Threads are per person as well as per agent.
 *
 * Two people share this install, and a conversation is the most personal
 * record in it — the Doctor's thread carries symptoms verbatim. The summary
 * key encodes both, "<profile>:<agent>", rather than adding a column to a
 * table whose primary key already identifies exactly one row.
 */
function summaryKey(agent: Agent): string {
  return `${activeProfile()}:${agent}`;
}

/** Turns kept verbatim before summarisation kicks in. */
const VERBATIM_TURNS = 6;
/** Summarise once the unsummarised tail exceeds this. */
const SUMMARY_TRIGGER = 10;

export type StoredMessage = {
  id: string;
  agent: Agent;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  created_at: number;
};

export async function loadThread(
  agent: Agent,
  limit = 50,
): Promise<StoredMessage[]> {
  const db = scopedDb(agent);
  const rows = await db.query<StoredMessage>(
    `SELECT * FROM messages
      WHERE profile_id = ? AND agent = ? AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT ?`,
    [activeProfile(), agent, limit],
  );
  return rows.reverse();
}

export async function appendMessage(
  agent: Agent,
  role: StoredMessage['role'],
  content: string,
): Promise<string> {
  const db = scopedDb(agent);
  return db.insert('messages', {
    agent,
    role,
    content,
    created_at: Date.now(),
    deleted_at: null,
  });
}

export async function clearThread(agent: Agent): Promise<void> {
  const db = scopedDb(agent);
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM messages
      WHERE profile_id = ? AND agent = ? AND deleted_at IS NULL`,
    [activeProfile(), agent],
  );
  for (const r of rows) await db.softDelete('messages', r.id);
  await db.run('DELETE FROM conversation_summaries WHERE id = ?', [
    summaryKey(agent),
  ]);
}

async function getSummary(
  agent: Agent,
): Promise<{ summary: string; uptoMsgId: string | null } | null> {
  const db = scopedDb(agent);
  const rows = await db.query<{ summary: string; upto_msg_id: string | null }>(
    'SELECT summary, upto_msg_id FROM conversation_summaries WHERE id = ?',
    [summaryKey(agent)],
  );
  const row = rows[0];
  return row ? { summary: row.summary, uptoMsgId: row.upto_msg_id } : null;
}

async function putSummary(
  agent: Agent,
  summary: string,
  uptoMsgId: string,
): Promise<void> {
  const db = scopedDb(agent);
  const existing = await getSummary(agent);
  if (existing) {
    await db.update('conversation_summaries', summaryKey(agent), {
      summary,
      upto_msg_id: uptoMsgId,
    });
  } else {
    await db.insert('conversation_summaries', {
      id: summaryKey(agent),
      summary,
      upto_msg_id: uptoMsgId,
    });
  }
}

/**
 * Compress everything older than the verbatim window into one paragraph.
 *
 * Costs one model call, and only when the thread has grown past the trigger —
 * far cheaper than carrying the full history on every turn forever.
 */
export async function maybeSummarise(
  agent: Agent,
  cfg: ProviderConfig,
): Promise<void> {
  const thread = await loadThread(agent, 200);
  const existing = await getSummary(agent);

  const startIdx = existing?.uptoMsgId
    ? thread.findIndex((m) => m.id === existing.uptoMsgId) + 1
    : 0;
  const unsummarised = thread.slice(startIdx);
  if (unsummarised.length <= SUMMARY_TRIGGER) return;

  const toCompress = unsummarised.slice(0, -VERBATIM_TURNS);
  if (toCompress.length === 0) return;

  const transcript = toCompress
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');

  const result = await chat(cfg, {
    messages: [
      {
        role: 'system',
        content:
          'Compress this conversation into one short paragraph of durable ' +
          'facts and open threads. Keep anything the user stated about ' +
          'themselves. Drop pleasantries and anything already resolved. ' +
          'No preamble.',
      },
      {
        role: 'user',
        content:
          (existing ? `Existing summary:\n${existing.summary}\n\nNew:\n` : '') +
          transcript,
      },
    ],
    temperature: 0,
    maxTokens: 300,
  });

  const text = result.text.trim();
  if (text) await putSummary(agent, text, toCompress[toCompress.length - 1].id);
}

export type ContextOptions = {
  agent: Agent;
  systemPrompt: string;
  /** De-identified facts from domain/state.ts. */
  stateSlice: string | null;
  userMessage: string;
};

/**
 * Builds the exact array that goes over the wire.
 *
 * Order matters: persona, then state, then compressed history, then the recent
 * verbatim turns, then the new message. Nothing else is included — no
 * identifiers, no full log, no accumulated context from previous turns.
 */
export async function buildContext(
  opts: ContextOptions,
): Promise<ChatMessage[]> {
  const { agent, systemPrompt, stateSlice, userMessage } = opts;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ];

  if (stateSlice) {
    messages.push({
      role: 'system',
      content:
        'What is currently known, assembled from the local record:\n' +
        stateSlice,
    });
  }

  const summary = await getSummary(agent);
  if (summary) {
    messages.push({
      role: 'system',
      content: `Earlier in this conversation:\n${summary.summary}`,
    });
  }

  const thread = await loadThread(agent, 200);
  const startIdx = summary?.uptoMsgId
    ? thread.findIndex((m) => m.id === summary.uptoMsgId) + 1
    : Math.max(0, thread.length - VERBATIM_TURNS);

  for (const m of thread.slice(startIdx)) {
    if (m.role === 'user' || m.role === 'assistant') {
      messages.push({ role: m.role, content: m.content });
    }
  }

  messages.push({ role: 'user', content: userMessage });
  return messages;
}
