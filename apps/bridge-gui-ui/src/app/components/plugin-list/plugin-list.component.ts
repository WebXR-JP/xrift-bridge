/**
 * プラグイン一覧の表示部品。
 *
 * 左に使用可能な種別（正本は `snapshot.plugins.kinds`）、右に起動中の個体
 * （正本は `plugins.instances`）を出す。取得・判定は行わず、表示と割当て要求・
 * 解除要求の送出だけを担う。種別ごとの適格判定 DTO は契約に無いため、
 * 候補は「使用中でない生存セッション」の写しに留める。
 * 選択は行の一時状態であり、インスタンスや snapshot として扱わない。
 * 拒否後の自動転送・自動再試行はしない。`assignments` だけから個体を作らない。
 */
import { Component, computed, input, output, signal } from "@angular/core";
import { NgIcon, provideIcons } from "@ng-icons/core";
import {
  lucideActivity,
  lucideMessageSquareText,
  lucidePlus,
  lucidePuzzle,
  lucideX,
} from "@ng-icons/lucide";
import type {
  OwnedPluginInstanceSummary,
  PluginAssignmentSummary,
  PluginKindSummary,
  PluginOwnershipPhase,
  SessionSummary,
} from "bridge-gui-contract/management";
import { HlmButton } from "../../ui/button/hlm-button.ts";
import { HlmInput } from "../../ui/input/hlm-input.ts";
import { HlmSeparator } from "../../ui/separator/hlm-separator.ts";

/** 割当て要求。種別トークンと選択した生存セッションの識別子を載せる。 */
export interface PluginAssignRequest {
  /** 割り当てる種別トークン。 */
  readonly pluginKind: string;
  /** 割り当てる生存セッションのローカル識別子。 */
  readonly localSessionId: string;
}

/** 解除要求。描画した所有記録の三識別子を載せる。 */
export interface PluginUnassignRequest {
  /** 描画した所有記録のインスタンス識別子。 */
  readonly instanceId: string;
  /** 描画した所有記録のローカル識別子。 */
  readonly localSessionId: string;
  /** 描画した所有記録の接続口識別子。 */
  readonly portId: string;
}

/** 既知種別の表示補助。登録内容ではなく表示名・説明・図像だけを載せる。 */
interface KnownPluginDisplay {
  /** 短い表示名。 */
  readonly name: string;
  /** 1行の説明。 */
  readonly description: string;
  /** `<ng-icon>` に渡す登録名。 */
  readonly iconName: string;
}

// ADR: 表示補助表は既知種別の表示だけに使い、未登録種別の表示には使わない。
// 正本は `snapshot.plugins.kinds` であり、この表に無い登録種別は
// `label` と汎用アイコンで表示する（静的表から種別を出さない）。
/** 既知種別の表示補助表。 */
const KNOWN_PLUGIN_DISPLAY: Readonly<Record<string, KnownPluginDisplay>> = {
  text: {
    name: "テキスト送信",
    description: "ワールドに固定テキストを表示する。",
    iconName: "lucideMessageSquareText",
  },
  diagnostic: {
    name: "診断（echo・ping）",
    description: "疎通と往復を確認する。",
    iconName: "lucideActivity",
  },
};

/** 未知の登録種別に当てる汎用アイコンの登録名。 */
const FALLBACK_ICON_NAME = "lucidePuzzle";

@Component({
  selector: "app-plugin-list",
  standalone: true,
  imports: [NgIcon, HlmButton, HlmInput, HlmSeparator],
  providers: [
    provideIcons({
      lucideActivity,
      lucideMessageSquareText,
      lucidePlus,
      lucidePuzzle,
      lucideX,
    }),
  ],
  templateUrl: "./plugin-list.component.html",
})
export class PluginListComponent {
  /** 登録済み種別の一覧（正本）。 */
  readonly kinds = input<readonly PluginKindSummary[]>([]);

  /** 管理層が所有する個体の一覧（正本）。 */
  readonly instances = input<readonly OwnedPluginInstanceSummary[]>([]);

  /** 現在の割当て一覧の写し。 */
  readonly assignments = input<readonly PluginAssignmentSummary[]>([]);

  /** 生存セッション一覧。候補の表示に使う。 */
  readonly sessions = input<readonly SessionSummary[]>([]);

  /**
   * プラグイン操作の失敗表示。安全な定型メッセージ文字列だけを受け、空なら出さない。
   *
   * 本文・payload・生の DTO 全文は載せない。
   */
  readonly error = input<string>("");

  /** 割当ての要求。種別トークンと選択した識別子を載せる。 */
  readonly assignRequested = output<PluginAssignRequest>();

  /** 割当て解除の要求。描画した所有記録の三識別子を載せる。 */
  readonly unassignRequested = output<PluginUnassignRequest>();

  // ADR: 接続先の選択は行の一時状態にのみ保持し、snapshot の一部にしない。
  // 候補の消滅・拒否で別候補への自動転送・自動再試行はしない。
  /** 選択を開いている種別トークン。閉じている間は `null`。 */
  readonly expandedKind = signal<string | null>(null);

  /** 種別ごとの選択下書き（種別トークン→ローカル識別子）。未選択は空文字。 */
  readonly drafts = signal<Readonly<Record<string, string>>>({});

  /** 使用中の生存セッション識別子。割当て写しと所有記録の和集合である。 */
  readonly usedSessionIds = computed(() => {
    const used = new Set<string>();
    for (const assignment of this.assignments()) {
      used.add(assignment.localSessionId);
    }
    for (const instance of this.instances()) {
      used.add(instance.localSessionId);
    }
    return used;
  });

  /** 割当て候補。使用中でない生存セッションだけを載せる。 */
  readonly candidates = computed(() => {
    const used = this.usedSessionIds();
    return this.sessions().filter((session) => !used.has(session.localSessionId));
  });

  /**
   * 種別行の表示（名称・説明・図像）を返す。
   *
   * @param kind - 登録種別の表示状態。
   * @returns 既知種別は補助表、未知種別は `label` と汎用アイコン。
   */
  displayFor(kind: PluginKindSummary): KnownPluginDisplay {
    const known = KNOWN_PLUGIN_DISPLAY[kind.pluginKind];
    if (known !== undefined) {
      return known;
    }
    return {
      name: kind.label,
      description: `種別 ${kind.pluginKind}（由来 ${kind.pluginId}）`,
      iconName: FALLBACK_ICON_NAME,
    };
  }

  /**
   * 起動中個体の表示（名称・図像）を返す。段階は含めない。
   *
   * @param instance - 所有する個体の表示状態。
   * @returns 既知種別は補助表、未知種別（登録表に無い場合を含む）は識別子と汎用アイコン。
   */
  instanceDisplayFor(instance: OwnedPluginInstanceSummary): KnownPluginDisplay {
    const known = KNOWN_PLUGIN_DISPLAY[instance.pluginKind];
    if (known !== undefined) {
      return known;
    }
    const registered = this.kinds().find((kind) => kind.pluginKind === instance.pluginKind);
    return {
      name: registered?.label ?? instance.pluginKind,
      description: `種別 ${instance.pluginKind}（由来 ${instance.pluginId}）`,
      iconName: FALLBACK_ICON_NAME,
    };
  }

  /**
   * 種別の所有件数を返す。上限判定はこの件数で行う。
   *
   * @param pluginKind - 種別トークン。
   * @returns 所有中の件数。
   */
  instanceCountOf(pluginKind: string): number {
    return this.instances().filter((instance) => instance.pluginKind === pluginKind).length;
  }

  /**
   * 種別が同時所有の上限に達しているか判定する。最終判定は本体が行う。
   *
   * @param kind - 登録種別の表示状態。
   * @returns 上限（`null` は上限なし）に達している場合に真。
   */
  isFull(kind: PluginKindSummary): boolean {
    return kind.maxInstances !== null && this.instanceCountOf(kind.pluginKind) >= kind.maxInstances;
  }

  /**
   * 種別行の選択が開いている場合に真。
   *
   * @param kind - 登録種別の表示状態。
   * @returns 開いている場合に真。
   */
  isExpanded(kind: PluginKindSummary): boolean {
    return this.expandedKind() === kind.pluginKind;
  }

  /**
   * 種別行の選択下書きを返す。未選択は空文字である。
   *
   * @param pluginKind - 種別トークン。
   * @returns 下書きのローカル識別子または空文字。
   */
  draftFor(pluginKind: string): string {
    return this.drafts()[pluginKind] ?? "";
  }

  /**
   * 種別行の選択を開閉する。開閉自体は RPC を送らない。
   *
   * @param kind - 対象の登録種別。
   */
  onToggleAdd(kind: PluginKindSummary): void {
    if (this.isExpanded(kind)) {
      this.closeDraft(kind.pluginKind);
      return;
    }
    this.expandedKind.set(kind.pluginKind);
  }

  /**
   * 選択下書きの変更を一時状態へ写す。RPC は送らない。
   *
   * @param kind - 対象の登録種別。
   * @param value - 選択中のローカル識別子（未選択は空文字）。
   */
  onDraftChange(kind: PluginKindSummary, value: string): void {
    this.drafts.update((current) => ({ ...current, [kind.pluginKind]: value }));
  }

  /**
   * 選択を取り消して閉じる。RPC は送らない。
   *
   * @param kind - 対象の登録種別。
   */
  onCancel(kind: PluginKindSummary): void {
    this.closeDraft(kind.pluginKind);
  }

  /**
   * 選択を確定して割当てを要求する。下書きが候補に残っている場合だけ送る。
   * 送信後は下書きを閉じる（別候補への自動転送はしない）。
   *
   * @param kind - 対象の登録種別。
   */
  onConfirm(kind: PluginKindSummary): void {
    if (!this.canConfirm(kind)) {
      return;
    }
    const localSessionId = this.draftFor(kind.pluginKind);
    this.assignRequested.emit({ pluginKind: kind.pluginKind, localSessionId });
    this.closeDraft(kind.pluginKind);
  }

  /**
   * 確定操作（起動して割り当てる）を押せるか判定する。
   *
   * @param kind - 対象の登録種別。
   * @returns 下書きが現候補に残っている場合に真。
   */
  canConfirm(kind: PluginKindSummary): boolean {
    const draft = this.draftFor(kind.pluginKind);
    if (draft === "") {
      return false;
    }
    return this.candidates().some((session) => session.localSessionId === draft);
  }

  /** 選択下書きを捨てて閉じる。 */
  private closeDraft(pluginKind: string): void {
    this.drafts.update((current) => {
      if (!(pluginKind in current)) {
        return current;
      }
      const next: Record<string, string> = { ...current };
      delete next[pluginKind];
      return next;
    });
    if (this.expandedKind() === pluginKind) {
      this.expandedKind.set(null);
    }
  }

  /**
   * 候補行の表示文を作る。
   *
   * @param session - 生存セッションの表示状態。
   * @returns 論理名・種別・方向・接続の表示文。
   */
  candidateText(session: SessionSummary): string {
    return `論理名 ${session.sessionId}・${session.kind}・${session.direction}・接続 ${session.connectionId}`;
  }

  /**
   * 個体に対応する現割当てを返す。取れない場合は `null` とする。
   *
   * @param instance - 所有する個体の表示状態。
   * @returns 対応する現割当て。無ければ `null`。
   */
  assignmentOf(instance: OwnedPluginInstanceSummary): PluginAssignmentSummary | null {
    return (
      this.assignments().find((assignment) => assignment.instanceId === instance.instanceId) ?? null
    );
  }

  /**
   * 接続先セッションの表示状態を返す。生存を終えた場合は `null` とする。
   *
   * @param localSessionId - 個体のローカル識別子。
   * @returns 対応する生存セッション。無ければ `null`。
   */
  sessionOf(localSessionId: string): SessionSummary | null {
    return this.sessions().find((session) => session.localSessionId === localSessionId) ?? null;
  }

  /**
   * 所有段階の表示文を作る。緑の「稼働中」は `active` のときだけである。
   *
   * @param phase - 所有の段階。
   * @returns 段階の表示文。
   */
  phaseText(phase: PluginOwnershipPhase): string {
    switch (phase) {
      case "active":
        return "稼働中";
      case "initializing":
        return "起動処理中";
      case "releasing":
        return "解除処理中";
      case "cleanupFailed":
        return "回収失敗（未回収）";
    }
  }

  /**
   * 解除を要求する。描画した所有記録の三識別子を渡す。
   * 稼働中の接続先操作であり、再割当ては送らない。
   *
   * @param instance - 描画した所有記録。
   */
  onRemove(instance: OwnedPluginInstanceSummary): void {
    this.unassignRequested.emit({
      instanceId: instance.instanceId,
      localSessionId: instance.localSessionId,
      portId: instance.portId,
    });
  }
}
