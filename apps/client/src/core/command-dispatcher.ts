import type { AppRoute } from '../platform/ports'
import type { AppServices } from './app-services'
import {
  applyCommandLocalTransition,
  dispatchRegisteredCommand,
  reconcileRegisteredCommand,
  type CommandLocalRecovery,
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
  | {
      readonly kind: 'local-recovery-required'
      readonly presentation: CommandReconciliation
      readonly recovery: CommandLocalRecovery
    }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'stale-attempt' }
  | { readonly kind: 'unexpected-error' }

type LocalRecoveryRequiredResult = {
  readonly kind: 'local-recovery-required'
  readonly presentation: CommandReconciliation
  readonly recovery: CommandLocalRecovery
}

export type LocalRecoveryResult =
  | {
      readonly kind: 'reconciled'
      readonly presentation: CommandReconciliation
    }
  | LocalRecoveryRequiredResult
  | {
      readonly kind: 'local-recovery-forbidden'
      readonly presentation: CommandReconciliation
    }

const localRecoveryFailure = (
  recovery: CommandLocalRecovery
): LocalRecoveryRequiredResult => ({
  kind: 'local-recovery-required',
  presentation: {
    tone: 'warning',
    message:
      '命令已完成，但本地页面切换失败。请使用安全恢复入口重试本地切换；不会再次发送写命令。'
  },
  recovery
})

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
    let outcome: RegisteredCommandOutcome<ClientCommandKind>
    try {
      outcome = await dispatchRegisteredCommand(
        this.services(),
        envelope.command,
        envelope.key
      )
    } catch {
      this.pending.markUnknown(envelope)
      return { kind: 'unexpected-error' }
    }
    const disposition = dispositionForOutcome(outcome)
    const settled = this.pending.settle(envelope, disposition)
    if (!settled) return { kind: 'stale-attempt' }
    if (disposition === 'unknown') return { kind: 'unknown' }

    const presentation = reconcileRegisteredCommand(
      envelope.command,
      outcome
    )
    const transition = presentation.localTransition
    if (transition === undefined) {
      return { kind: 'reconciled', presentation }
    }
    const recovery = {
      principalId: envelope.principalId,
      completedPresentation: presentation,
      transition
    } satisfies CommandLocalRecovery
    try {
      await applyCommandLocalTransition(this.services(), transition)
      return { kind: 'reconciled', presentation }
    } catch {
      // 服务端结果已确定且 envelope 已结算。这里只保留无写请求的本地
      // 恢复 locator，绝不能重新标为 unknown 或重发原 idempotency key。
      return localRecoveryFailure(recovery)
    }
  }

  public async retryLocalRecovery(
    recovery: CommandLocalRecovery
  ): Promise<LocalRecoveryResult> {
    if (
      this.services().session.authenticationContext()?.principalId !==
      recovery.principalId
    ) {
      return {
        kind: 'local-recovery-forbidden',
        presentation: {
          tone: 'error',
          message:
            '当前账号不能恢复上一账号的页面上下文。请返回家庭列表重新选择。'
        }
      }
    }
    try {
      await applyCommandLocalTransition(
        this.services(),
        recovery.transition
      )
      return {
        kind: 'reconciled',
        presentation: recovery.completedPresentation
      }
    } catch {
      return localRecoveryFailure(recovery)
    }
  }
}
