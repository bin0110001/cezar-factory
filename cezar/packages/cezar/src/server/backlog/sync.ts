import { EDITABLE_FIELDS, type BacklogFields, type EditableField } from './model.ts';

export interface FieldConflict {
  field: EditableField;
  base: unknown;
  local: unknown;
  remote: unknown;
}

export interface ThreeWayResult {
  /** Local values plus remote-only changes; conflicting fields keep the LOCAL value until resolved. */
  merged: BacklogFields;
  /** Fields only the remote side changed (applied locally). */
  fromRemote: EditableField[];
  /** Fields only the local side changed (must be pushed to GitHub). */
  toPush: EditableField[];
  /** Fields both sides changed differently; never auto-resolved and never silently dropped. */
  conflicts: FieldConflict[];
}

/** Three-way merge against `base`, the last value set both sides agreed on. */
export function threeWayMerge(base: BacklogFields, local: BacklogFields, remote: BacklogFields): ThreeWayResult {
  const merged: BacklogFields = { ...local };
  const fromRemote: EditableField[] = [];
  const toPush: EditableField[] = [];
  const conflicts: FieldConflict[] = [];
  for (const field of EDITABLE_FIELDS) {
    const b = base[field], l = local[field], r = remote[field];
    const localChanged = l !== b, remoteChanged = r !== b;
    if (localChanged && remoteChanged) {
      if (l !== r) conflicts.push({ field, base: b, local: l, remote: r });
      continue; // identical edits converge without a push
    }
    if (remoteChanged) { (merged as unknown as Record<string, unknown>)[field] = r; fromRemote.push(field); }
    else if (localChanged) toPush.push(field);
  }
  return { merged, fromRemote, toPush, conflicts };
}
