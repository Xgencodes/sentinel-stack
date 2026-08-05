import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get('health')
  getHealth() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'sentinel-stack',
      components: [
        'ehr-bridge',
        'sentinel-registry',
        'sentinel-signals',
        'sentinel-model',
        'sentinel-delivery',
      ],
    };
  }
}
