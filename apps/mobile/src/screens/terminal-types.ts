export type TerminalViewProps = {
  threadId: string;
  chunk: { threadId: string; data: string; n: number } | null;
  alive: boolean;
  error: string;
  openPty: (threadId: string, cols: number, rows: number) => void;
  writePty: (threadId: string, data: string) => void;
  resizePty: (threadId: string, cols: number, rows: number) => void;
};
