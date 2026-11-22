import type { BoardCollaboration, BoardCollaborationConnection, BoardEditor } from '@apeiro/editor';
import { useEffect, useRef, useState } from 'react';

const sameKey = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((item, i) => Object.is(item, b[i])));

/** Connect before mounting descendants, including those declared directly under a provider. */
export function useCollaboration(
  editor: BoardEditor,
  adapter: BoardCollaboration | undefined,
  reportError: (error: unknown) => void,
) {
  const latest = useRef(adapter);
  useEffect(() => {
    latest.current = adapter;
  });
  const [identity, setIdentity] = useState(() => ({ editor, key: adapter?.key.slice() }));
  if (identity.editor !== editor || !sameKey(identity.key, adapter?.key)) {
    setIdentity({ editor, key: adapter?.key.slice() });
  }
  const [status, setStatus] = useState<{
    identity: typeof identity;
    ready: boolean;
    error?: unknown;
  } | null>(null);
  const current = useRef<BoardCollaborationConnection | null>(null);

  useEffect(() => {
    if (!identity.key) return;
    let active = true;
    let connection: BoardCollaborationConnection | undefined;
    const fail = (error: unknown) => {
      if (!active) return;
      connection?.destroy();
      if (current.current === connection) current.current = null;
      connection = undefined;
      setStatus({ identity, ready: false, error });
      reportError(error);
    };
    // Old descendant cleanups finish before a new document is connected. StrictMode's
    // discarded setup never establishes a connection or modifies the shared document.
    queueMicrotask(() => {
      if (!active) return;
      try {
        connection = latest.current!.connect(editor, reportError);
        current.current = connection;
        Promise.resolve(connection.ready).then(() => {
          if (active) setStatus({ identity, ready: true });
        }, fail);
      } catch (error) {
        fail(error);
      }
    });
    return () => {
      active = false;
      connection?.destroy();
      if (current.current === connection) current.current = null;
    };
  }, [editor, identity, reportError]);

  useEffect(() => {
    if (!current.current) return;
    try {
      adapter?.update?.(current.current);
    } catch (error) {
      reportError(error);
    }
  });

  return {
    ready: !adapter || (status?.identity === identity && status.ready),
    failed:
      !!adapter && status?.identity === identity && !status.ready && Object.hasOwn(status, 'error'),
    error: status?.identity === identity ? status.error : undefined,
  };
}
