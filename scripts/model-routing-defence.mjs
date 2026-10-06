import { createAIDefence } from '@claude-flow/aidefence';

const severities = ['low', 'medium', 'high', 'critical'];
const types = ['prompt_injection', 'jailbreak', 'pii_exposure', 'instruction_override',
  'role_switching', 'context_manipulation', 'encoding_attack', 'unknown'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function refusal(code, metadata) {
  const error = new Error('Model routing defence refused this boundary.');
  error.code = code; error.metadata = Object.freeze(metadata); return error;
}
function valid(result) {
  return object(result) && typeof result.safe === 'boolean' && typeof result.piiFound === 'boolean'
    && Number.isFinite(result.detectionTimeMs) && result.detectionTimeMs >= 0
    && typeof result.inputHash === 'string' && result.inputHash.length > 0
    && Array.isArray(result.threats) && result.safe === (result.threats.length === 0)
    && result.threats.every(threat => object(threat) && severities.includes(threat.severity)
      && types.includes(threat.type) && Number.isFinite(threat.confidence)
      && threat.confidence >= 0 && threat.confidence <= 1
      && ['id', 'pattern', 'description'].every(key => typeof threat[key] === 'string')
      && threat.detectedAt instanceof Date && Number.isFinite(threat.detectedAt.getTime()));
}

/** Local in-memory detection only. PII is disclosed as metadata, not an automatic refusal rule. */
export function createModelRoutingDefence(factory = createAIDefence) {
  let detector;
  return async function assertText(text) {
    let result;
    try {
      if (typeof text !== 'string') throw new Error();
      detector ??= factory({ enableLearning: true, enablePIIDetection: true });
      result = await detector.detect(text);
      if (!valid(result)) throw new Error();
    } catch {
      throw refusal('MODEL_ROUTING_DEFENCE_UNAVAILABLE', { allowed: false, reason: 'detector-unavailable' });
    }
    const severity = result.threats.reduce((max, threat) => Math.max(max, severities.indexOf(threat.severity)), -1);
    const metadata = { allowed: severity < 1, piiFound: result.piiFound,
      threatCount: result.threats.length, severity: severity < 0 ? 'none' : severities[severity] };
    if (!metadata.allowed) throw refusal('MODEL_ROUTING_DEFENCE_BLOCKED', metadata);
    return Object.freeze(metadata);
  };
}

export const assertModelRoutingText = createModelRoutingDefence();
