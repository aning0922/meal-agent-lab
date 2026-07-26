import type { AppRoute } from '../platform/ports'
import type { AppServices } from './app-services'
import {
  dispatchRegisteredCommand,
  reconcileRegisteredCommand,
  type CommandReconciliation,
  type ClientCommandKind,
  type RegisteredCommand,
  type RegisteredCommandOutcome
} from './command-registry'
import {
  dispositionForOutcome,
  type PendingActionIdempotency
} from './idempotency'

export type RetryDispatchResult =
  | { readonly kind: 'idle' }
  | { readonly kind: 'in-flight' }
  | { readonly kind: 'auth-suspended' }
  | {
      readonly kind: 'reconciled'
      readonly presentation: CommandReconciliation
    }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'stale-attempt' }
  | { readonly kind: 'unexpected-error' }

/**
 * registry 的唯一执行入口。首次提交和全局恢复都经过同一 dispatcher；
 * retry 从 coordinator envelope 读取完整 snapshot，绝不从当前页面/GET
 * 结果重建 payload。
 */
export class PendingCommandDispatcher {
  public constructor(
    private readonly services: () => AppServices,
    private readonly pending: PendingActionIdempotency
  ) {}

  public async execute<K extends ClientCommandKind>(
    action: string,
    ownerRoute: AppRoute,
    command: RegisteredCommand<K>
  ): Promise<RegisteredCommandOutcome<K>> {
    const envelope = this.pending.acquireCommand(
      action,
      ownerRoute,
      command
    )
    try {
      const outcome = await dispatchRegisteredCommand(
        this.services(),
        envelope.command,
        envelope.key
      )
      const settled = this.pending.settle(
        envelope,
        dispositionForOutcome(outcome)
      )
      if (!settled) {
        throw new Error('stale command attempt was ignored')
      }
      return outcome
    } catch (error) {
      this.pending.markUnknown(envelope)
      throw error
    }
  }

  public async retryActive(): Promise<RetryDispatchResult> {
    const status = this.pending.status()
    if (status.phase === 'idle') return { kind: 'idle' }
    if (status.phase === 'in-flight') return { kind: 'in-flight' }
    if (status.phase === 'auth-suspended') {
      return { kind: 'auth-suspended' }
    }
    const envelope = this.pending.beginRetry()
    if (envelope === null) return { kind: 'in-flight' }
    try {
      const outcome = await dispatchRegisteredCommand(
        this.services(),
        envelope.command,
        envelope.key
      )
      const disposition = dispositionForOutcome(outcome)
      const settled = this.pending.settle(envelope, disposition)
      if (!settled) return { kind: 'stale-attempt' }
      if (disposition === 'unknown') return { kind: 'unknown' }
      return {
        kind: 'reconciled',
        presentation: await reconcileRegisteredCommand(
          this.services(),
          envelope.command,
          outcome
        )
      }
    } catch {
      this.pending.markUnknown(envelope)
      return { kind: 'unexpected-error' }
    }
  }
}
