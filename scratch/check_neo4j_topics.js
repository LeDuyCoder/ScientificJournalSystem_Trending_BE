import dotenv from 'dotenv';
dotenv.config();

import neo4j from 'neo4j-driver';

const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
);

const session = driver.session({ defaultAccessMode: 'READ' });
try {
  const result = await session.run(`
    MATCH (t:Topic)<-[:HAS_TOPIC]-(a:Article)
    RETURN t.name AS name, count(a) AS cnt
    ORDER BY cnt DESC
    LIMIT 20
  `);
  console.log('TOP 20 Topics in Neo4j with article counts:');
  result.records.forEach(r => {
    console.log(`- "${r.get('name')}": ${r.get('cnt').toNumber()} articles`);
  });
} catch (err) {
  console.error(err);
} finally {
  await session.close();
  await driver.close();
}
