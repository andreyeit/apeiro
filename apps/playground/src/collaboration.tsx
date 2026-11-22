import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Tool } from 'apeiro';
import { Board, useBoard, useHistory, useTool, Sticky, Rect } from 'apeiro/react';
import type { CollaborationStatus } from 'apeiro/react';
import 'apeiro/styles.css';
import './collaboration.css';

const roomId = new URLSearchParams(location.search).get('room') || 'playground';

const users = [
  { name: 'Андрей', color: '#2563eb' },
  { name: 'Анна', color: '#db2777' },
];

function Collaboration() {
  return (
    <>
      <h1>Совместная доска · React + Yjs + Socket.IO</h1>
      <p>
        Комната «{roomId}». Два клиента подключены к серверу через Socket.IO. Откройте эту же ссылку
        в другой вкладке — изменения появятся и там. Undo отменяет правки своего клиента.
      </p>
      <main>
        {users.map((user, index) => (
          <CollaborativeClient key={user.name} user={user} seed={index === 0} />
        ))}
      </main>
    </>
  );
}

const TOOLS: Array<[Tool, string]> = [
  ['select', 'Выбор'],
  ['hand', 'Рука'],
  ['sticky', 'Стикер'],
  ['rect', 'Фигура'],
  ['ellipse', 'Эллипс'],
  ['connector', 'Связь'],
  ['text', 'Текст'],
  ['pen', 'Перо'],
];

function CollaborativeClient({ user, seed }: { user: (typeof users)[number]; seed: boolean }) {
  const [status, setStatus] = useState<CollaborationStatus>('connecting');
  return (
    <section>
      <Board
        className="canvas"
        collaboration={{
          url: location.origin,
          roomId,
          user,
          onStatusChange: setStatus,
        }}
        fallback={<section className="fallback">Подключение…</section>}
        errorFallback={(error) => (
          <section className="fallback">Ошибка подключения: {String(error)}</section>
        )}
        config={{
          camera: {
            minZoom: 0.1,
            maxZoom: 8,
          },
          smoothCamera: false,
          onReady: (board) => {
            board.camera.set({ x: 0, y: 0, zoom: 1 });
          },
        }}
      >
        <ClientBoard user={user} status={status} seed={seed} />
      </Board>
    </section>
  );
}

function ClientBoard({
  user,
  status,
  seed,
}: {
  user: (typeof users)[number];
  status: CollaborationStatus;
  seed: boolean;
}) {
  const board = useBoard();
  const tool = useTool();
  const statuses = {
    connecting: 'Подключение…',
    connected: 'В сети',
    disconnected: 'Нет связи',
    error: 'Ошибка связи',
    destroyed: 'Отключён',
  };
  const { canUndo, canRedo } = useHistory();

  return (
    <>
      <header>
        <strong style={{ color: user.color }}>{user.name}</strong>
        <span className="connection" data-status={status} role="status">
          {statuses[status]}
        </span>
        {TOOLS.map(([id, label]) => (
          <button key={id} aria-pressed={tool === id} onClick={() => board.tools.activate(id)}>
            {label}
          </button>
        ))}
        <button disabled={!canUndo} onClick={board.history.undo}>
          Undo
        </button>
        <button disabled={!canRedo} onClick={board.history.redo}>
          Redo
        </button>
        <button onClick={() => board.camera.zoomTo('fit')}>Показать всё</button>
      </header>
      {seed && (
        <>
          <Sticky
            id="demo-sticky"
            x={100}
            y={100}
            width={240}
            height={180}
            text="Дважды нажмите, чтобы редактировать вместе"
          />
          <Rect id="demo-rect" x={420} y={140} width={180} height={120} />
        </>
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Collaboration />
  </StrictMode>,
);
