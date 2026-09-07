const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const projectIdStr = process.argv[2];
  if (!projectIdStr) {
    console.error('Usage: node sync_scope.cjs <projectId>');
    process.exit(1);
  }
  const projectId = BigInt(projectIdStr);
  console.log(`Syncing scope for project ${projectId}...`);

  try {
    // 1. Clear existing scope for this project to avoid stale data
    await prisma.$executeRawUnsafe(`DELETE FROM "Project_Article_Scope" WHERE project_id = $1`, projectId);

    // 2. Sync from Project Categories
    const cats = await prisma.subject_Category_Project.findMany({ where: { project_id: projectId } });
    const catIds = cats.map(c => c.subject_category_id);
    
    if (catIds.length > 0) {
      console.log(`- Syncing ${catIds.length} categories...`);
      await prisma.$executeRawUnsafe(`
        INSERT INTO "Project_Article_Scope" (project_id, article_id, publication_year)
        SELECT DISTINCT $1, a.article_id, a.publication_year
        FROM "Article" a
        WHERE a.primary_topic IN (
          SELECT topic_id FROM "Topic" WHERE subject_category_id = ANY($2::bigint[])
        )
        ON CONFLICT DO NOTHING;
      `, projectId, catIds);

      await prisma.$executeRawUnsafe(`
        INSERT INTO "Project_Article_Scope" (project_id, article_id, publication_year)
        SELECT DISTINCT $1, a.article_id, a.publication_year
        FROM "Sub_Topic" st
        JOIN "Topic" sub_topic ON st.topic_id = sub_topic.topic_id
        JOIN "Article" a ON st.article_id = a.article_id
        WHERE sub_topic.subject_category_id = ANY($2::bigint[])
        ON CONFLICT DO NOTHING;
      `, projectId, catIds);
    }

    // 3. Sync from Project Keywords
    const kws = await prisma.project_Keyword.findMany({ where: { project_id: projectId } });
    const kwIds = kws.map(c => c.keyword_id);
    
    if (kwIds.length > 0) {
      console.log(`- Syncing ${kwIds.length} keywords...`);
      await prisma.$executeRawUnsafe(`
        INSERT INTO "Project_Article_Scope" (project_id, article_id, publication_year)
        SELECT DISTINCT $1, a.article_id, a.publication_year
        FROM "Keyword_Article" ka
        JOIN "Article" a ON ka.article_id = a.article_id
        WHERE ka.keyword_id = ANY($2::bigint[])
        ON CONFLICT DO NOTHING;
      `, projectId, kwIds);
    }

    console.log('✅ Sync complete!');
  } catch (err) {
    console.error('❌ Error syncing:', err);
  } finally {
    await prisma.$disconnect();
  }
}
run();
