import { z } from 'zod';

export const mcpGatewayStatusSchema = z.object({
  configured: z.boolean(),
  endpointHost: z.string().nullable(),
  endpointValid: z.boolean(),
});
export type McpGatewayStatus = z.infer<typeof mcpGatewayStatusSchema>;

export const mcpGatewayCheckResponseSchema = z.object({
  status: z.enum(['healthy', 'unconfigured', 'unhealthy']),
  checkedAt: z.string(),
  serverName: z.string().optional(),
  serverVersion: z.string().optional(),
  protocolVersion: z.string().optional(),
  errorCategory: z.enum(['configuration', 'authentication', 'forbidden', 'tls', 'unavailable', 'invalid-response']).optional(),
});
export type McpGatewayCheckResponse = z.infer<typeof mcpGatewayCheckResponseSchema>;
