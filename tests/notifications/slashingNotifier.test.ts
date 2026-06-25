import { InMemoryNotificationDeliveryStore } from '../../src/notifications/deliveryStore';
import { IdempotentEmailService } from '../../src/notifications/emailService';
import { SlashingEvent, SlashingNotifier, notificationIdFor } from '../../src/notifications/slashingNotifier';
import { IdempotentWebhookService } from '../../src/notifications/webhookService';

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, name: string): void {
    if (condition) {
      console.log(`  ok ${name}`);
      passed++;
    } else {
      console.log(`  fail ${name}`);
      failed++;
    }
  }

  console.log('\nSlashing Notifier Tests\n');

  const event: SlashingEvent = {
    id: 'slash-001',
    validatorId: 'validator-a',
    operatorEmail: 'ops@example.com',
    webhookUrl: 'https://hooks.example.com/slashing',
    reason: 'double-sign',
    amount: 500n,
    occurredAt: new Date('2026-06-25T00:00:00.000Z'),
  };

  {
    const store = new InMemoryNotificationDeliveryStore();
    const emailDeliveries: string[] = [];
    const webhookDeliveries: string[] = [];
    let webhookAttempts = 0;

    const emailService = new IdempotentEmailService(async (notification) => {
      emailDeliveries.push(notification.notificationId);
    });
    const webhookService = new IdempotentWebhookService(async (notification) => {
      webhookAttempts++;
      if (webhookAttempts === 1) {
        throw new Error('webhook timeout');
      }
      webhookDeliveries.push(notification.notificationId);
    });

    const notifier = new SlashingNotifier(store, emailService, webhookService, {
      maxRetries: 3,
      backoffMs: [0, 0, 0],
      sleep: async () => undefined,
    });

    const result = await notifier.notifySlashing(event);
    const emailStatus = await store.getDelivery(event.id, 'email');
    const webhookStatus = await store.getDelivery(event.id, 'webhook');

    assert(result.email === 'delivered', 'email channel reports delivered');
    assert(result.webhook === 'delivered', 'webhook channel reports delivered after retry');
    assert(emailDeliveries.length === 1, 'email is delivered exactly once when webhook retries');
    assert(webhookDeliveries.length === 1, 'webhook is delivered exactly once after timeout retry succeeds');
    assert(webhookAttempts === 2, 'webhook attempts retry independently');
    assert(emailStatus?.status === 'delivered', 'email delivery status is stored');
    assert(webhookStatus?.status === 'delivered', 'webhook delivery status is stored');
    assert(webhookStatus?.attempts === 2, 'webhook status records retry attempt count');
  }

  {
    const store = new InMemoryNotificationDeliveryStore();
    const emailDeliveries: string[] = [];
    const webhookDeliveries: string[] = [];

    const notifier = new SlashingNotifier(
      store,
      new IdempotentEmailService(async (notification) => {
        emailDeliveries.push(notification.notificationId);
      }),
      new IdempotentWebhookService(async (notification) => {
        webhookDeliveries.push(notification.notificationId);
      }),
      { backoffMs: [0, 0, 0], sleep: async () => undefined },
    );

    await notifier.notifySlashing(event);
    const secondResult = await notifier.notifySlashing(event);

    assert(secondResult.email === 'skipped', 'delivered email channel is skipped on whole-function retry');
    assert(secondResult.webhook === 'skipped', 'delivered webhook channel is skipped on whole-function retry');
    assert(emailDeliveries.length === 1, 'whole-function retry does not duplicate email');
    assert(webhookDeliveries.length === 1, 'whole-function retry does not duplicate webhook');
  }

  {
    const store = new InMemoryNotificationDeliveryStore();
    const emailDeliveries: string[] = [];
    const webhookDeliveries: string[] = [];
    let webhookAttempts = 0;

    const notifier = new SlashingNotifier(
      store,
      new IdempotentEmailService(async (notification) => {
        emailDeliveries.push(notification.notificationId);
      }),
      new IdempotentWebhookService(async (notification) => {
        webhookAttempts++;
        if (webhookAttempts === 1) {
          throw new Error('webhook timeout');
        }
        webhookDeliveries.push(notification.notificationId);
      }),
      { maxRetries: 0, backoffMs: [0], sleep: async () => undefined },
    );

    let firstCallFailed = false;
    try {
      await notifier.notifySlashing(event);
    } catch {
      firstCallFailed = true;
    }

    const retryResult = await notifier.notifySlashing(event);

    assert(firstCallFailed, 'whole-function retry scenario starts with webhook failure');
    assert(retryResult.email === 'skipped', 'outer retry skips already delivered email');
    assert(retryResult.webhook === 'delivered', 'outer retry delivers failed webhook channel');
    assert(emailDeliveries.length === 1, 'outer retry does not resend successful email');
    assert(webhookDeliveries.length === 1, 'outer retry delivers webhook exactly once');
  }

  {
    const emailNotificationId = notificationIdFor(event.id, 'email');
    const webhookNotificationId = notificationIdFor(event.id, 'webhook');
    assert(emailNotificationId !== webhookNotificationId, 'idempotency keys are per-channel');
    assert(emailNotificationId === notificationIdFor(event.id, 'email'), 'idempotency keys are stable across retries');
  }

  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('slashingNotifier.test.ts crashed:', err);
  process.exit(1);
});
