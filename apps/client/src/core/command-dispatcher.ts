import type { AppRoute } from '../platform/ports'
import type { AppServices } from './app-services'
import {
  dispatchRegisteredCommand,
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
  | { readonly kind: 'auth-suspended' }
  | {
      readonly kind: 'dispatched'
      readonly outcome: { readonly kind: string }
    }
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
      this.pending.settle(action, dispositionForOutcome(outcome))
      return outcome
    } catch (error) {
      this.pending.markUnknown(action)
      throw error
    }
  }

  public async retryActive(): Promise<RetryDispatchResult> {
    const status = this.pending.status()
    if (status.phase === 'idle') return { kind: 'idle' }
    if (status.phase === 'auth-suspended') {
      return { kind: 'auth-suspended' }
    }
    const envelope = this.pending.activeSnapshot()
    if (envelope === null) return { kind: 'auth-suspended' }
    try {
      const outcome = await dispatchRegisteredCommand(
        this.services(),
        envelope.command,
        envelope.key
      )
      this.pending.settle(
        envelope.action,
        dispositionForOutcome(outcome)
      )
      return { kind: 'dispatched', outcome }
    } catch {
      this.pending.markUnknown(envelope.action)
      return { kind: 'unexpected-error' }
    }
  }
}
