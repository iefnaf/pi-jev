/**
 * `prepareCompaction` is what pi runs right before `session_before_compact`,
 * and it decides the span the hook receives. pi does not export it from the
 * package root, so it is loaded from the installed dist to keep the eval's
 * cuts identical to production instead of a re-implementation that drifts.
 */
export {
  prepareCompaction,
  type CompactionPreparation,
} from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js';
