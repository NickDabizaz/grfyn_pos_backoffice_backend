const os = require('os');

exports.index = (req, res) => {
  const cpuLoad = os.loadavg();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = Math.round((usedMem / totalMem) * 100);

  const heapTotal = Math.round(process.memoryUsage().heapTotal / 1024 / 1024 * 10) / 10;
  const heapUsed = Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 10) / 10;
  const heapPercent = Math.round((heapUsed / heapTotal) * 100);

  const uptime = os.uptime();
  const osHours = Math.floor(uptime / 3600);
  const osMinutes = Math.floor((uptime % 3600) / 60);
  const osSeconds = Math.floor(uptime % 60);

  const pUptime = process.uptime();
  const pHours = Math.floor(pUptime / 3600);
  const pMinutes = Math.floor((pUptime % 3600) / 60);
  const pSeconds = Math.floor(pUptime % 60);

  res.render('layout', { view: 'system', 
    title: 'System Monitoring',
    active: 'system',
    cpu: {
      load1: cpuLoad[0].toFixed(2),
      load5: cpuLoad[1].toFixed(2),
      load15: cpuLoad[2].toFixed(2),
      cores: os.cpus().length
    },
    memory: {
      total: Math.round(totalMem / 1024 / 1024 / 1024 * 10) / 10,
      free: Math.round(freeMem / 1024 / 1024 / 1024 * 10) / 10,
      used: Math.round(usedMem / 1024 / 1024 / 1024 * 10) / 10,
      percent: memPercent
    },
    heap: {
      total: heapTotal,
      used: heapUsed,
      percent: heapPercent
    },
    uptime: {
      os: `${osHours}h ${osMinutes}m ${osSeconds}s`,
      process: `${pHours}h ${pMinutes}m ${pSeconds}s`
    },
    nodeVersion: process.version,
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname()
  });
};

exports.api = (req, res) => {
  const cpuLoad = os.loadavg();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  res.json({
    cpu: {
      load1: cpuLoad[0],
      load5: cpuLoad[1],
      load15: cpuLoad[2],
      cores: os.cpus().length
    },
    memory: {
      total: Math.round(totalMem / 1024 / 1024),
      free: Math.round(freeMem / 1024 / 1024),
      used: Math.round((totalMem - freeMem) / 1024 / 1024)
    },
    heap: {
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    },
    uptime: {
      os: os.uptime(),
      process: process.uptime()
    }
  });
};
