import React, { createContext, useContext, useEffect, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { useSession, useWorkspace } from '../session';
import { resolveTimelineImage } from '../utils/localFileUrl';

export const TimelineContext = createContext({ threadId: '', cwd: '', onOpenThread: undefined as ((id: string) => void) | undefined });
export function TimelineImage({ source, onOpenFile }: { source: string; onOpenFile: (path: string) => void }) {
  const { threadId, cwd } = useContext(TimelineContext);
  const workspace = useWorkspace();
  const session = useSession();
  const target = resolveTimelineImage(source, cwd);
  const remote = /^(https?:|data:)/i.test(target);
  const file = workspace.files[target];
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const allowed = !remote || /^https?:\/\//i.test(target) || (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(target) && target.length <= 8 * 1024 * 1024);
  useEffect(() => {
    setFailed(false);
    if (!remote && threadId && (!file || retry)) workspace.requestFile(threadId, target);
  }, [target, threadId, session.connectionIdentity, retry]);
  const uri = remote ? target : file?.encoding === 'base64' && !file.truncated ? `data:image/${file.ext.replace('.', '').replace('jpg', 'jpeg')};base64,${file.content}` : '';
  const request = session.requestState('get_file', threadId, target);
  const error = !allowed || failed || file?.error || file?.truncated || request?.error;
  return <View><Pressable accessibilityRole="button" onPress={() => { if (error) setRetry(n => n + 1); else if (!remote) onOpenFile(target); }} style={{ marginVertical: 8 }}>
    {error ? <Text>图片加载失败或超过预览限制 · 点击重试</Text> : uri ? <Image source={{ uri }} resizeMode="contain" style={{ width: '100%', height: 240 }} onError={() => setFailed(true)} /> : <Text>正在加载图片…</Text>}
  </Pressable>{!remote ? <Pressable onPress={() => onOpenFile(target)}><Text>打开文件预览</Text></Pressable> : null}</View>;
}
