// Replay a recorded fixture through the production extraction pipeline.
//
// Given the raw chunks captured by tools/record-session.js, this rebuilds the
// terminal screen exactly as the session layer would and extracts the reply
// with the same pure functions. No PTY, no network, no timers — so it is safe
// to run in CI and is the basis of the extraction tests.

import { VTScreen } from './vt-screen.js';
import { extractResponse, conversationText } from './extract.js';

// Matches FALLBACK_CONVO_END_ROW in freebuff.js; only used when a fixture has
// no recognisable status bar.
const FALLBACK_CONVO_END_ROW = 30;

// Marker written into the chunk stream by the recorder when it sent the prompt.
export const INPUT_MARKER = '@@input-sent@@';

/**
 * @param {object} fixture recorded session (see tools/record-session.js)
 * @returns {{ text: string, strategy: string, transcript: string,
 *             before: string, scrollbackLines: number }}
 */
export function replayFixture(fixture) {
  const meta = fixture.meta || {};
  const cols = meta.cols || 120;
  const rows = meta.rows || 40;
  const sentinel = meta.input || null;

  const screen = new VTScreen(cols, rows);

  let before = '';

  for (const chunk of fixture.chunks || []) {
    // The recorder marks the moment it typed the prompt; everything after it
    // is the reply, everything before is prior conversation.
    if (chunk.marker === INPUT_MARKER) {
      before = conversationText(screen, { fallbackEndRow: FALLBACK_CONVO_END_ROW });
      continue;
    }
    screen.process(chunk.data);
  }

  const transcript = conversationText(screen, { fallbackEndRow: FALLBACK_CONVO_END_ROW });
  const result = extractResponse({ before, after: transcript, sentinel });

  return {
    ...result,
    transcript,
    before,
    scrollbackLines: screen.getScrollbackLength(),
  };
}