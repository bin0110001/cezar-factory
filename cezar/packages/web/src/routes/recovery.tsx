import { useMemo } from 'react'
import { RecoveryConsole } from '@/components/recovery-console'
import { createFixtureRecoveryClient } from '@/lib/recovery-contract'

// Minimal Recovery route. Uses the empty fixture adapter until the controller read-model/action API (#70)
// lands; wiring it is a one-line adapter swap here.
export function RecoveryRoute() {
  const client = useMemo(() => createFixtureRecoveryClient({ incidents: [], grantedScopes: [], conflict: null }), [])
  return <RecoveryConsole client={client} />
}
