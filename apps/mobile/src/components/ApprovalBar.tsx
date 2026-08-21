import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { decodeApprovalCommand } from '../history';
import type { Approval, Decision } from '../types';
import { useTheme } from '../theme-context';

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
    <View style={[styles.wrap, { backgroundColor: colors.bg, borderColor: '#f59e0b' }]}>
      <View style={styles.headerRow}>
        <Text style={{ fontSize: 16 }}>🛡️</Text>
        <Text style={[styles.title, { color: colors.text }]}>需要权限审批 (Waiting for Approval)</Text>
      </View>
      <Text style={[styles.detail, { color: colors.muted }]} numberOfLines={4} selectable>
        {detail}
      </Text>
      <View style={styles.actionsRow}>
        <Pressable
          style={[styles.btn, { backgroundColor: '#10b981' }]}
          onPress={() => onDecide('accept')}
        >
          <Text style={styles.btnTextPrimary}>允许 / 批准</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, { backgroundColor: colors.shell, borderWidth: 1, borderColor: colors.line }]}
          onPress={() => onDecide('acceptForSession')}
        >
          <Text style={[styles.btnText, { color: colors.text }]}>本会话允许</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, { backgroundColor: 'rgba(239, 68, 68, 0.1)', borderWidth: 1, borderColor: 'rgba(239, 68, 68, 0.3)' }]}
          onPress={() => onDecide('denied')}
        >
          <Text style={[styles.btnText, { color: '#ef4444' }]}>拒绝 / 否决</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderWidth: 1.5,
    borderRadius: 16,
    padding: 12,
    gap: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  title: {
    fontSize: 13,
    fontWeight: '700',
  },
  detail: {
    fontSize: 12,
    lineHeight: 17,
    fontFamily: 'monospace',
    backgroundColor: 'rgba(0,0,0,0.03)',
    padding: 8,
    borderRadius: 8,
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  btn: {
    flex: 1,
    paddingVertical: 9,
    paddingHorizontal: 4,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnTextPrimary: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  btnText: {
    fontSize: 11,
    fontWeight: '600',
  },
});
