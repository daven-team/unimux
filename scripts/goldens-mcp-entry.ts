// One module graph for scripts/goldens-mcp.mjs: the tool layer, the automation schemas, the delegation settings and the
// translations share one zod instance (describeError tells a ZodError by instanceof).
export { MCP_TOOLS, LEGACY_OPERATIONS, callTool, describeError, mcpInstructions, supportsTask, toolsForRole } from '../src/main/mcpTools';
export { automationSchemas } from '../src/shared/automation';
export { delegationOf } from '../src/shared/delegation';
export { translate } from '../src/shared/i18n';
export { z } from 'zod';
