// config.ts requires these at import; the tests never reach the model API or GIMP.
process.env.MODEL_API_KEY ??= 'test';
process.env.GIMP_MCP_PYTHON ??= 'python';
process.env.GIMP_MCP_SERVER ??= 'gimp_mcp_server.py';
