import { RisoScraper, Riso9450Scraper } from './risoScraper';
import { CloudClient, CloudConfig } from './cloudClient';

export class UsagePollingService {
  private scraper: RisoScraper;
  private cloudClient: CloudClient;
  private intervalId: NodeJS.Timeout | null = null;
  private readonly pollingIntervalMs: number;
  private isRunning: boolean = false;

  constructor(
    risoAdminUrl: string,
    cloudConfig: CloudConfig,
    pollingIntervalMs: number = 5 * 60 * 1000 // Default 5 minutes
  ) {
    this.scraper = new Riso9450Scraper(risoAdminUrl);
    this.cloudClient = new CloudClient(cloudConfig);
    this.pollingIntervalMs = pollingIntervalMs;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('Usage polling service is already running');
      return;
    }

    try {
      await this.scraper.initialize();
      this.isRunning = true;

      console.log(`Starting usage polling service with ${this.pollingIntervalMs / 1000}s interval`);

      // Run initial poll
      await this.pollAndSubmitUsageData();

      // Set up recurring polls
      this.intervalId = setInterval(async () => {
        await this.pollAndSubmitUsageData();
      }, this.pollingIntervalMs);

    } catch (error) {
      console.error('Failed to start usage polling service:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      console.log('Usage polling service is not running');
      return;
    }

    console.log('Stopping usage polling service');

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    await this.scraper.cleanup();
    this.isRunning = false;
  }

  private async pollAndSubmitUsageData(): Promise<void> {
    try {
      console.log('Polling Risograph usage data...');

      const usageData = await this.scraper.scrapeUsageData();

      if (usageData.length > 0) {
        console.log(`Found ${usageData.length} usage records, submitting to cloud server...`);

        const result = await this.cloudClient.submitUsageData(usageData);

        console.log(`Successfully processed ${result.processed} usage records`);

        if (result.errors.length > 0) {
          console.warn('Some records had errors:', result.errors);
        }
      } else {
        console.log('No new usage data found');
      }

    } catch (error) {
      console.error('Error during usage data polling:', error);

      // Attempt to reinitialize the browser if it crashed
      if (error instanceof Error && error.message.includes('Browser')) {
        try {
          await this.scraper.cleanup();
          await this.scraper.initialize();
          console.log('Successfully reinitialized scraper after browser error');
        } catch (reinitError) {
          console.error('Failed to reinitialize scraper:', reinitError);
        }
      }
    }
  }

  isServiceRunning(): boolean {
    return this.isRunning;
  }

  getPollingInterval(): number {
    return this.pollingIntervalMs;
  }

  // Method to manually trigger a poll (useful for testing or admin actions)
  async triggerManualPoll(): Promise<void> {
    if (!this.isRunning) {
      throw new Error('Service must be started before triggering manual poll');
    }

    console.log('Triggering manual usage data poll...');
    await this.pollAndSubmitUsageData();
  }
}
