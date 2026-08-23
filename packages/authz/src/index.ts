export {
  OpaAdapterError,
  OpaInputInvalidError,
  OpaOutputInvalidError,
  OpaUnavailableError,
} from './opa-errors.js';
export { opaEnvelopeSchema } from './output-schema.js';
export type { OpaEnvelope } from './output-schema.js';
export { OpaDecisionClient } from './decision-client.js';
export { OpaModeDecisionAdapter, OpaPartitionDecisionAdapter } from './opa-adapter.js';
