import type { BrowserDriver, Clock, LlmClient, Logger } from './ports';
import { noopLogger, systemClock } from './ports';
import type { Action, AgentRunResult, ConversationTurn, StepRecord } from './types';
import { hashSnapshot } from './snapshot';

export interface AgentDeps {
  driver: BrowserDriver;
  llm: LlmClient;
  clock?: Clock;
  logger?: Logger;
  maxSteps?: number;
  /** Cooperative abort flag, flipped by the UI stop button. */
  signal?: { aborted: boolean };
  /** Earlier exchanges in this chat (previous goals + own results), so
   *  the model remembers what it already did in earlier runs. */
  conversation?: ConversationTurn[];
}

function actionKey(action: Action): string {
  return JSON.stringify(action);
}

export function describeAction(action: Action): string {
  switch (action.type) {
    case 'click':
      return `click [${action.index}]`;
    case 'click_at':
      return `click_at [${action.index}] (${action.x},${action.y})`;
    case 'type':
      return `type into [${action.index}]`;
    case 'scroll':
      return `scroll ${action.direction}`;
    case 'navigate':
      return `navigate to ${action.url}`;
    case 'wait':
      return `wait ${action.ms}ms`;
    default:
      return action.type;
  }
}

/**
 * The agent state machine:
 *   Observing -> Thinking -> Acting -> Verifying -> (loop | Done)
 *
 * No-effect handling (learned from a real failure log): an unchanged
 * page no longer kills the run. The model first gets explicit harness
 * notices ("the page did NOT change, do not repeat that action") and a
 * chance to change strategy. The run only ends as `stuck` when the
 * model keeps insisting on the identical action that provably does
 * nothing, or the page stays frozen for many observations in a row.
 */
export async function runAgent(goal: string, deps: AgentDeps): Promise<AgentRunResult> {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? noopLogger;
  const maxSteps = deps.maxSteps ?? 25;
  const history: StepRecord[] = [];

  let prevHash: string | null = null;
  let prevUrl: string | null = null;
  let unchanged = 0;
  let lastActionKey: string | null = null;
  let sameActionRepeats = 0;

  for (let step = 1; step <= maxSteps; step++) {
    if (deps.signal?.aborted) {
      return { status: 'aborted', summary: 'Stopped by user.', history };
    }

    let snapshot;
    try {
      snapshot = await deps.driver.observe();
    } catch (err) {
      const summary = `Observe failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.log('error', summary);
      return { status: 'error', summary, history };
    }
    const hash = hashSnapshot(snapshot);
    if (prevHash !== null) {
      unchanged = hash === prevHash ? unchanged + 1 : 0;
    }
    prevHash = hash;
    logger.log('observe', { step, url: snapshot.url, elements: snapshot.elements.length });

    if (unchanged >= 6) {
      const summary = `Page did not change for 6 observations in a row (stuck at ${snapshot.url}).`;
      logger.log('stuck', { step });
      return { status: 'stuck', summary, history };
    }

    const notices: string[] = [];
    if (unchanged > 0) {
      notices.push(
        `The page did NOT change after the previous action (unchanged ${unchanged}x in a row). That action had no visible effect — do NOT repeat it. Choose a different element or a different strategy (scroll, wait for loading, click the parent/menu item first), or finish with done/ask_user if appropriate.`,
      );
    }
    if (prevUrl !== null && snapshot.url !== prevUrl) {
      // Navigation right after acting usually means a submit/save went
      // through. Without this milestone the model cheerfully starts the
      // same form again (observed in the field: one "fill randomly" goal
      // produced three saved records).
      notices.push(
        `The page navigated (${prevUrl} -> ${snapshot.url}) since the last step. Navigation after a click usually means a form was submitted/saved or a new section opened. FIRST check the snapshot: if the goal is already complete (e.g. the record you created is visible), finish with done — do NOT start the same form again unless the goal explicitly asks for multiple records.`,
      );
    }
    prevUrl = snapshot.url;
    const notice = notices.length > 0 ? notices.join(' ') : undefined;

    let action;
    try {
      action = await deps.llm.nextAction({ goal, snapshot, history, notice, conversation: deps.conversation });
    } catch (err) {
      const summary = `LLM failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.log('error', summary);
      return { status: 'error', summary, history };
    }
    logger.log('action', { step, action });

    if (action.type === 'done') {
      history.push({ step, snapshotHash: hash, action });
      return { status: 'done', summary: action.summary, history };
    }
    if (action.type === 'ask_user') {
      history.push({ step, snapshotHash: hash, action });
      return { status: 'needs_user', summary: action.question, history };
    }

    // Repetition guard: same action, proposed over and over, while the
    // page provably does not react. Notices were already given; stop
    // instead of burning steps (and clicks) forever.
    const key = actionKey(action);
    if (key === lastActionKey) {
      sameActionRepeats++;
    } else {
      lastActionKey = key;
      sameActionRepeats = 0;
    }
    if ((sameActionRepeats >= 2 && unchanged >= 2) || sameActionRepeats >= 4) {
      history.push({ step, snapshotHash: hash, action });
      const summary =
        `Agent kept repeating ${describeAction(action)} (${sameActionRepeats + 1}x) while the page did not change. ` +
        `The element may be the wrong target, disabled, or covered — try a different goal phrasing or guide it manually.`;
      logger.log('stuck', { step, reason: 'repeated-no-effect-action' });
      return { status: 'stuck', summary, history };
    }

    const record: StepRecord = { step, snapshotHash: hash, action };
    history.push(record);

    if (action.type === 'wait') {
      await clock.sleep(Math.min(action.ms, 30_000));
      record.result = { ok: true, message: `Waited ${action.ms}ms`, level: 0 };
      continue;
    }

    try {
      record.result = await deps.driver.act(action);
    } catch (err) {
      record.result = {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        level: 0,
      };
    }
    logger.log('act-result', { step, result: record.result });
  }

  return {
    status: 'max_steps',
    summary: `Reached the ${maxSteps}-step limit without finishing.`,
    history,
  };
}
