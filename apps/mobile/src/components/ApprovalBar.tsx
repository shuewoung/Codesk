import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { decodeApprovalCommand } from '../history';
import type { Approval, Decision } from '../types';
import { useTheme } from '../theme-context';
import { radius, space } from '../theme';
import { GhostButton, PrimaryButton } from './ui';

export function ApprovalBar({
  approval,
  onDecide,
}: {
  approval: Approval;
  onDecide: (decision: Decision) => void;
}) {
  const { colors } = useTheme();
  const detail = decodeApprovalCommand(approval.command || '') || approval.reason || '检测到需要您确认的审批请求。';
  return (
    <View style={[styles.wrap, { backgroundColor: colors.shell, borderColor: colors.line }]}>
      <Text style={[styles.title, { color: colors.text }]}>需要你批准</Text>
      <Text style={[styles.detail, { color: colors.muted }]} numberOfLines={6}>
        {detail}
      </Text>
      <PrimaryButton label="允许" onPress={() => onDecide('accept')} />
      <GhostButton label="本会话允许" onPress={() => onDecide('acceptForSession')} />
      <GhostButton label="拒绝" onPress={() => onDecide('denied')} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  title: { fontSize: 15, fontWeight: '600' },
  detail: { fontSize: 13, lineHeight: 18 },
});
