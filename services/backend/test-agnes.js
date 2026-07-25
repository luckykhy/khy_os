const server = require('./src/services/aiManagementServer');
const http = require('http');
(async () => {
  try {
    const port = await server.start();
    console.log('Server started on port', port);

    await new Promise(r => setTimeout(r, 3000));

    // Check /api/models
    const req1 = http.get('http://localhost:' + port + '/api/models', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const adapters = json.data || [];
          console.log('\n/api/models adapters:', adapters.length);
          for (const m of adapters) {
            if (m.adapter === 'api') {
              console.log('api adapter - available:', m.available, 'health:', m.health);
              console.log('api model ids:', (m.models || []).map(x => x.id));
            }
          }
        } catch(e) {
          console.log('Parse error:', e.message);
        }

        // Also check /api/status for adapter details
        const req2 = http.get('http://localhost:' + port + '/api/status', (res2) => {
          let data2 = '';
          res2.on('data', chunk => data2 += chunk);
          res2.on('end', () => {
            try {
              const json2 = JSON.parse(data2);
              const adapters2 = json2.data?.adapters || [];
              console.log('\n/api/status adapters:', adapters2.length);
              for (const a of adapters2) {
                if (a.type === 'api') {
                  console.log('api adapter status:', JSON.stringify(a).substring(0, 300));
                }
              }
            } catch(e) {
              console.log('Parse error2:', e.message);
            }
            server.stop();
            process.exit(0);
          });
        });
        req2.on('error', (e) => { console.log('req2 error:', e.message); server.stop(); process.exit(1); });
      });
    });
    req1.on('error', (e) => { console.log('req1 error:', e.message); server.stop(); process.exit(1); });
  } catch(e) {
    console.log('Error:', e.message);
    process.exit(1);
  }
})();
