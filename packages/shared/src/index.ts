// @muninhq/shared — cross-package types and utilities. Must remain
// vertical-agnostic.

export * from './config-schema';
export * from './config-helpers';
export * from './configuration-registry';
export * from './eval-types';
export {
  composeConfiguration,
  computeCompositeHash,
  computeSchemaHash,
  ConfigurationCompositionError,
} from './config-compose';
export * from './demo-pack';
export * from './demo-pack-loader';
export * from './munin-home';
