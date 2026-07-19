import fs from 'fs';
import path from 'path';

const files = [
  'analytics.service.js',
  'countryCollaboration.service.js',
  'crossLinks.service.js',
  'dashboard.service.js',
  'dashboardSearch.service.js',
  'distribution.service.js',
  'forecast.service.js',
  'frontier.service.js',
  'geoDistribution.service.js',
  'impactMatrix.service.js',
  'impactQuartiles.service.js',
  'journal-quartile.service.js',
  'journal-ranking.service.js',
  'keywordVectors.service.js',
  'matrix.service.js',
  'migration.service.js',
  'network.service.js',
  'productivityMatrix.service.js',
  'rankings.service.js',
  'temporalShift.service.js',
  'topology.service.js',
  'trends.service.js'
];

const servicesDir = './src/services';

files.forEach(file => {
  const filePath = path.join(servicesDir, file);
  if (fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf8');
    // Replace const CACHE_TTL = <number>;
    content = content.replace(/const\s+CACHE_TTL\s*=\s*\d+;/g, 'const CACHE_TTL = 43200; // 12 hours');
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Updated CACHE_TTL in ${file}`);
  } else {
    console.log(`File not found: ${file}`);
  }
});
