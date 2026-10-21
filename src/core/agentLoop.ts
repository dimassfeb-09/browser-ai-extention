import type { BrowserDriver, Clock, LlmClient, Logger } from './ports';
import { noopLogger, systemClock } from './ports';
import type { AgentRunResult, StepRecord } from './types';
import { hashSnapshot } from './snapshot';
import { isStuck } from './escalation';

export interface AgentDeps {
  driver: BrowserDriver;
  llm: LlmClient;
  clock?: Clock;
  logger?: Logger;
  maxSteps?: number;
  /** Cooperative abort flag, flipped by the UI stop button. */
  signal?: { aborted: boolean };
}

/**
 * The agent state machine:
 *   Observing -> Thinking -> Acting -> Verifying -> (loop | Done)
 * with exits to Stuck (page stopped changing), NeedsUser (ask_user),
 * MaxSteps and Aborted. Pure orchestration — all side effects go
 * through the ports, so the whole loop is unit-testable with fakes.
 */
export async function runAgent(goal: string, deps: AgentDeps): Promise<AgentRunResult> {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? noopLogger;
  const maxSteps = deps.maxSteps ?? 25;
  const history: StepRecord[] = [];
  const hashes: string[] = [];

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
    hashes.push(hash);
    logger.log('observe', { step, url: snapshot.url, elements: snapshot.elements.length });

    if (step > 1 && isStuck(hashes)) {
      const summary = `Page did not change for 3 observations in a row (stuck at ${snapshot.url}).`;
      logger.log('stuck', { step });
      return { status: 'stuck', summary, history };
    }

    let action;
    try {
      action = await deps.llm.nextAction({ goal, snapshot, history });
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
