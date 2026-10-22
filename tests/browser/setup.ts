import {
  prepareConsumer,
  writePackageReceipt,
} from "../../scripts/consumer.mjs";

/** The invocation owns the immutable build; specs own only their HTTP servers. */
export default async function setup() {
  const started = performance.now();
  const consumer = await prepareConsumer();
  const previousDist = process.env.CDP_VIEWER_TEST_CONSUMER_DIST;
  const cleanup = async () => {
    if (previousDist === undefined)
      delete process.env.CDP_VIEWER_TEST_CONSUMER_DIST;
    else process.env.CDP_VIEWER_TEST_CONSUMER_DIST = previousDist;
    await consumer.cleanup();
  };
  try {
    await writePackageReceipt(consumer);
    process.env.CDP_VIEWER_TEST_CONSUMER_DIST = consumer.dist;
    console.log(
      `Browser consumer setup completed in ${Math.round(performance.now() - started)}ms.`,
    );
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
