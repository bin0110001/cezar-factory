import type { VerificationProviderFactory } from '../../../../verification/executor.ts';
import { OcrWorkerClient } from './ocr-worker-client.js';
import { ocrPlugin } from './ocr-adapter.js';

export interface OcrServerEnvironment {
  CEZ_OCR_ENABLED?: string;
  CEZ_OCR_WORKER_URL?: string;
  CEZ_OCR_WORKER_TOKEN?: string;
  CEZ_OCR_GATEWAY_URL?: string;
  CEZ_OCR_MODEL_ALIAS?: string;
  CEZ_OCR_RULE_PATH?: string;
  CEZ_OCR_RULE_DIGEST?: string;
  CEZ_OCR_POLICY_DIGEST?: string;
  CEZ_OCR_MAX_TOKENS?: string;
  CEZ_OCR_CONCURRENCY?: string;
  CEZ_OCR_TIMEOUT_MINUTES?: string;
}

function positiveInteger(name: string, value: string | undefined, fallback: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`${name} must be an integer from 1 to ${max}`);
  return parsed;
}

function required(env: OcrServerEnvironment, name: keyof OcrServerEnvironment): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when CEZ_OCR_ENABLED=1`);
  return value;
}

/** Server-owned, opt-in OCR registration. The project workflow can select only the code-owned `ocr` provider. */
export function createOcrVerificationProviders(
  env: OcrServerEnvironment = process.env,
  fetchImpl?: typeof fetch,
): Readonly<Record<string, VerificationProviderFactory>> {
  if (env.CEZ_OCR_ENABLED !== '1') return {};
  const worker = new OcrWorkerClient({
    baseUrl: required(env, 'CEZ_OCR_WORKER_URL'),
    token: required(env, 'CEZ_OCR_WORKER_TOKEN'),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  const options = {
    gatewayUrl: required(env, 'CEZ_OCR_GATEWAY_URL'),
    // The actual LiteLLM key remains inside the scanner worker; the RPC client strips this marker.
    gatewayToken: 'worker-managed',
    modelAlias: required(env, 'CEZ_OCR_MODEL_ALIAS'),
    rulePath: required(env, 'CEZ_OCR_RULE_PATH'),
    ruleDigest: required(env, 'CEZ_OCR_RULE_DIGEST'),
    policyDigest: required(env, 'CEZ_OCR_POLICY_DIGEST'),
    budget: {
      maxTokens: positiveInteger('CEZ_OCR_MAX_TOKENS', env.CEZ_OCR_MAX_TOKENS, 10_000, 1_000_000),
      concurrency: positiveInteger('CEZ_OCR_CONCURRENCY', env.CEZ_OCR_CONCURRENCY, 1, 4),
      timeoutMinutes: positiveInteger('CEZ_OCR_TIMEOUT_MINUTES', env.CEZ_OCR_TIMEOUT_MINUTES, 10, 120),
    },
  };
  return {
    ocr: (context) => {
      if (!context.baseSha) throw new Error('OCR verification requires the immutable base revision');
      return ocrPlugin({
        ...options,
        repoPath: context.cwd,
        fromSha: context.baseSha,
        toSha: context.sourceSha,
        exec: worker.exec,
        readUsage: worker.readUsage.bind(worker),
      });
    },
  };
}

