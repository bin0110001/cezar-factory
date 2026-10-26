import type { ReactNode } from 'react'

type ValidationReceipt = {
  stage: string
  status: string
  reasonCode: string
  diagnosticComparison?: {
    status: string
    known: number
    new: number
    unclassified: number
  }
}

const stages = new Set(['changed', 'full', 'verify'])
const statuses = new Set(['passed', 'failed', 'skipped', 'unavailable', 'no-matching-tests', 'error'])

export function parseValidationReceipt(value: unknown): ValidationReceipt | null {
  let candidate = value
  if (typeof value === 'string') {
    const finalLine = value.trim().split(/\r?\n/).filter((line) => line.trim()).at(-1)
    if (!finalLine) return null
    try { candidate = JSON.parse(finalLine) } catch { return null }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  const receipt = candidate as Record<string, unknown>
  if (receipt.schemaVersion !== 1 || typeof receipt.stage !== 'string' || !stages.has(receipt.stage) ||
    typeof receipt.status !== 'string' || !statuses.has(receipt.status) || typeof receipt.reasonCode !== 'string') return null
  const summary: ValidationReceipt = { stage: receipt.stage, status: receipt.status, reasonCode: receipt.reasonCode }
  const comparison = receipt.diagnosticComparison
  if (comparison && typeof comparison === 'object' && !Array.isArray(comparison)) {
    const value = comparison as Record<string, unknown>
    if (typeof value.status === 'string' && Array.isArray(value.knownFingerprints) && Array.isArray(value.newFingerprints) &&
      typeof value.unclassifiedCount === 'number' && Number.isInteger(value.unclassifiedCount) && value.unclassifiedCount >= 0) {
      summary.diagnosticComparison = {
        status: value.status,
        known: value.knownFingerprints.length,
        new: value.newFingerprints.length,
        unclassified: value.unclassifiedCount,
      }
    }
  }
  return summary
}

export function ValidationReceiptSummary({ value }: { value: unknown }): ReactNode {
  const receipt = parseValidationReceipt(value)
  if (!receipt) return null
  return (
    <div data-slot="validation-receipt-summary" data-status={receipt.status} className="rounded border bg-background p-2 text-xs">
      <p className="font-semibold">Validation {receipt.status} · {receipt.stage}</p>
      <p className="text-soft-foreground">Reason: <code>{receipt.reasonCode}</code></p>
      {receipt.diagnosticComparison ? (
        <p className="text-soft-foreground" data-slot="diagnostic-comparison-summary">
          Diagnostics ({receipt.diagnosticComparison.status}): {receipt.diagnosticComparison.known} known · {receipt.diagnosticComparison.new} new · {receipt.diagnosticComparison.unclassified} unclassified
        </p>
      ) : null}
    </div>
  )
}
