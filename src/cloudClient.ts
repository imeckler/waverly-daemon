import { RisoUsageData } from './risoScraper';

export interface CloudConfig {
  serverUrl: string;
  daemonSecret: string;
}

export class CloudClient {
  private config: CloudConfig;

  constructor(config: CloudConfig) {
    this.config = config;
  }

  async submitUsageData(usageData: RisoUsageData[]): Promise<{ success: boolean; processed: number; errors: string[] }> {
    if (usageData.length === 0) {
      return { success: true, processed: 0, errors: [] };
    }

    try {
      const payload = {
        secret: this.config.daemonSecret,
        usageData: usageData.map(usage => ({
          userIdentifier: usage.userIdentifier,
          copiesPrinted: usage.copiesPrinted,
          stencilsCreated: usage.stencilsCreated,
          timestamp: usage.timestamp?.toISOString(),
          rawData: usage.rawData
        }))
      };

      const response = await fetch(`${this.config.serverUrl}/api/submit-usage-data`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = await response.json();

      if (result.errors && result.errors.length > 0) {
        console.warn('Some usage data had errors:', result.errors);
      }

      return {
        success: result.success,
        processed: result.processed,
        errors: result.errors || []
      };
    } catch (error) {
      console.error('Error submitting usage data to cloud:', error);
      throw error;
    }
  }
}
