import os from 'node:os';

export function lowerBuildPriority({
  setPriority = os.setPriority,
  priority = os.constants.priority.PRIORITY_BELOW_NORMAL,
} = {}) {
  try {
    setPriority(0, priority);
    return { applied: true, priority };
  } catch (error) {
    return { applied: false, priority, error: error.message };
  }
}
