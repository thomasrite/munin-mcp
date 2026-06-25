import { arr, bool, connectorBinding, obj, str } from '@muninhq/shared';
import type { ConnectorBinding } from '@muninhq/shared';

// A stub filesystem connector for the demo. Per-tenant configuration declares
// where to read files from; concrete values are supplied at runtime by the
// hosting layer, never committed here.

export const filesystem: ConnectorBinding = connectorBinding({
  packageName: '@muninhq/connector-filesystem',
  description: 'Reads documents from a directory on the local filesystem.',
  perTenantConfigSchema: obj(
    {
      rootPath: str({
        description: 'Absolute path of the directory to scan.',
      }),
      allowedExtensions: arr(str(), {
        description: 'File extensions to ingest (lowercase, with dot).',
      }),
      recursive: bool({ description: 'Whether to recurse into subdirectories.' }),
    },
    { required: ['rootPath', 'allowedExtensions'] },
  ),
});

export const connectors: readonly ConnectorBinding[] = [filesystem];
