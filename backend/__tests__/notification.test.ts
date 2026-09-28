
describe('NotificationHub', () => {
  test('sendNotification should handle empty channels', async () => {
    // Notification with no channels should not throw
    const { sendNotification } = await import('../src/services/notificationHub');
    await expect(sendNotification({
      event: 'payment_success',
      title: 'Test',
      message: 'Test message',
      channels: [],
    })).resolves.not.toThrow();
  });

  test('should batch reminders without error', async () => {
    const { sendBatchReminders } = await import('../src/services/notificationHub');
    await expect(sendBatchReminders(
      [],
      'subscription_expiring',
      'Test',
      'Test message'
    )).resolves.not.toThrow();
  });
});
