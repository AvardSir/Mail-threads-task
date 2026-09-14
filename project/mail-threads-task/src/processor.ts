// src/processor.ts

import type { MessageRow, UpdateThreadInput } from './db';

// ---- 1. DSU ----

class DSU {
  private readonly parent = new Map<string, string>();

  add(node: string): void {
    if (!this.parent.has(node)) {
      this.parent.set(node, node);
    }
  }

  find(node: string): string {
    const p = this.parent.get(node);
    if (p === undefined) {
      throw new Error(`DSU.find: unknown node "${node}"`);
    }
    if (p === node) {
      return node;
    }
    const root = this.find(p);
    this.parent.set(node, root);
    return root;
  }

  /** Родителем становится target (его корень). См. §14.4 / план §3.3. */
  union(child: string, target: string): void {
    const childRoot = this.find(child);
    const targetRoot = this.find(target);
    if (childRoot === targetRoot) {
      return;
    }
    this.parent.set(childRoot, targetRoot);
  }
}

// ---- 2. Private helpers ----

const collectLinks = (m: MessageRow): string[] => {
  const raw: Array<string | null> = [...m.references, m.inReplyTo];
  const result: string[] = [];
  for (const x of raw) {
    if (typeof x === 'string' && x.length > 0) {
      result.push(x);
    }
  }
  return result;
};

const computeParentId = (
  m: MessageRow,
  existingIds: Set<string>,
): string | null => {
  const raw: Array<string | null> = [...m.references, m.inReplyTo];
  for (let i = raw.length - 1; i >= 0; i--) {
    const candidate = raw[i];
    if (typeof candidate !== 'string' || candidate.length === 0) {
      continue;
    }
    if (candidate === m.externalId) {
      continue;
    }
    if (existingIds.has(candidate)) {
      return candidate;
    }
  }
  return null;
};

// ---- 3. Public API ----

export const buildUpdates = (
  messages: MessageRow[],
  existingIds: Set<string>,
): UpdateThreadInput[] => {
  const dsu = new DSU();

  // 3.1. Регистрируем узлы: все externalId + все id из links
  //      (мёртвые ссылки тоже становятся узлами — нужно для склейки тредов
  //      между запусками; см. план §3.3).
  for (const m of messages) {
    dsu.add(m.externalId);
    for (const link of collectLinks(m)) {
      dsu.add(link);
    }
  }

  // 3.2. Union. Обходим links в обратном порядке:
  //      [inReplyTo, references[last], ..., references[0]].
  //      Цель ссылки становится корнем → итоговый корень = references[0].
  for (const m of messages) {
    const links = collectLinks(m);
    for (let i = links.length - 1; i >= 0; i--) {
      const link = links[i];
      if (link === m.externalId) {
        continue;
      }
      dsu.union(m.externalId, link);
    }
  }

  // 3.3. Собираем результат в исходном порядке.
  return messages.map((m) => ({
    externalId: m.externalId,
    parentId: computeParentId(m, existingIds),
    threadKey: `t-${dsu.find(m.externalId)}`,
  }));
};