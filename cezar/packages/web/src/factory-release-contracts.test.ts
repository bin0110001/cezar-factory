import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  factoryDeploymentReceiptSchema,
  factoryReleaseManifestSchema,
  parseFactoryReleaseManifest,
} from '@open-mercato/cezar-api-client';

const fixtures = resolve(import.meta.dirname, '../../../../schemas/factory-release/fixtures');
async function readFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(fixtures, name), 'utf8'));
}

describe('Factory release contracts exposed to the Cezar cockpit', () => {
  it('uses the published shared fixtures through the cockpit API client contract', async () => {
    const manifest = await readFixture('manifest-valid.json');
    const receipt = await readFixture('receipt-active.json');
    expect(factoryReleaseManifestSchema.safeParse(manifest).success).toBe(true);
    expect(factoryDeploymentReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(parseFactoryReleaseManifest(await readFixture('manifest-unknown-schema.json')).status).toBe('unknown-schema');

    const mismatchedReceipt = { ...(receipt as Record<string, unknown>), observedSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
    expect(factoryDeploymentReceiptSchema.safeParse(mismatchedReceipt).success).toBe(false);
  });
});
