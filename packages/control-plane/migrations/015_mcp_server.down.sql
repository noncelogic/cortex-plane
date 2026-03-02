-- 015 down: Remove MCP server and tool tables, indexes, and enum types.

DROP TABLE IF EXISTS mcp_server_tool;
DROP TABLE IF EXISTS mcp_server;
DROP TYPE IF EXISTS mcp_transport;
DROP TYPE IF EXISTS mcp_server_status;
