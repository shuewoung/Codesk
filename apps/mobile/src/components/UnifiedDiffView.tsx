import React, { useMemo } from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';
import { useTheme } from '../theme-context';

type DiffLine = {
  type: 'hunk' | 'add' | 'del' | 'context' | 'meta';
  text: string;
  oldNum?: number;
  newNum?: number;
};

function parseDiffPatch(patch: string): DiffLine[] {
  const lines = (patch || '').split('\n');
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      result.push({ type: 'hunk', text: line });
      continue;
    }
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('***')) {
      result.push({ type: 'meta', text: line });
      continue;
    }
    if (line.startsWith('+')) {
      result.push({ type: 'add', text: line, newNum: newLine++ });
    } else if (line.startsWith('-')) {
      result.push({ type: 'del', text: line, oldNum: oldLine++ });
    } else {
      result.push({ type: 'context', text: line, oldNum: oldLine++, newNum: newLine++ });
    }
  }
  return result;
}

export function UnifiedDiffView({ patch }: { patch: string }) {
  const { colors } = useTheme();
  const diffLines = useMemo(() => parseDiffPatch(patch), [patch]);

  return (
    <ScrollView horizontal style={{ maxHeight: 400 }} contentContainerStyle={{ minWidth: '100%' }}>
      <View style={{ width: '100%' }}>
        {diffLines.map((line, idx) => {
          const isAdd = line.type === 'add';
          const isDel = line.type === 'del';
          const isHunk = line.type === 'hunk';
          const isMeta = line.type === 'meta';

          const rowBg = isAdd
            ? 'rgba(34, 197, 94, 0.12)'
            : isDel
            ? 'rgba(239, 68, 68, 0.12)'
            : isHunk
            ? 'rgba(59, 130, 246, 0.08)'
            : 'transparent';

          const textColor = isAdd
            ? '#16a34a'
            : isDel
            ? '#dc2626'
            : isHunk
            ? '#2563eb'
            : isMeta
            ? colors.muted
            : colors.text;

          return (
            <View
              key={idx}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: rowBg,
                paddingVertical: 1,
                paddingHorizontal: 4,
              }}
            >
              <Text
                style={{
                  fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                  fontSize: 10.5,
                  color: colors.muted,
                  width: 26,
                  textAlign: 'right',
                  marginRight: 6,
                  opacity: 0.6,
                }}
              >
                {line.oldNum ?? ''}
              </Text>
              <Text
                style={{
                  fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                  fontSize: 10.5,
                  color: colors.muted,
                  width: 26,
                  textAlign: 'right',
                  marginRight: 8,
                  opacity: 0.6,
                }}
              >
                {line.newNum ?? ''}
              </Text>
              <Text
                selectable
                style={{
                  fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                  fontSize: 11.5,
                  color: textColor,
                  fontWeight: isHunk ? '600' : '400',
                  flex: 1,
                }}
              >
                {line.text}
              </Text>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}
