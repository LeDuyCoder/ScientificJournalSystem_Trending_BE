const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function syncOneProject(projectId) {
  console.log(`\nSyncing scope for project ${projectId}...`);

  const project = await prisma.project.findUnique({
    where: { project_id: projectId }
  });

  if (!project) {
    console.warn(`Project ${projectId} not found in database.`);
    return;
  }

  // 1. Clear existing scope for this project
  await prisma.$executeRawUnsafe(`DELETE FROM "Project_Article_Scope" WHERE project_id = $1`, projectId);

  // 2. Gather category IDs from Project.subject_area AND Subject_Category_Project
  let catIds = [];

  if (project.subject_area) {
    const saCats = await prisma.subject_Category.findMany({
      where: {
        subject_area_id: project.subject_area,
        is_deleted: false
      },
      select: { subject_category_id: true }
    });
    catIds.push(...saCats.map(c => c.subject_category_id));
  }

  const explicitCats = await prisma.subject_Category_Project.findMany({
    where: { project_id: projectId },
    select: { subject_category_id: true }
  });
  catIds.push(...explicitCats.map(c => c.subject_category_id));
  catIds = [...new Set(catIds)];

  if (catIds.length > 0) {
    console.log(`- Found ${catIds.length} categories for project ${projectId}...`);
    
    await prisma.$executeRawUnsafe(`
      INSERT INTO "Project_Article_Scope" (project_id, article_id, publication_year)
      SELECT DISTINCT $1::bigint, a.article_id, a.publication_year
      FROM "Article" a
      WHERE a.primary_topic IN (
        SELECT topic_id FROM "Topic" WHERE subject_category_id = ANY($2::bigint[])
      )
      ON CONFLICT DO NOTHING;
    `, projectId, catIds);

    await prisma.$executeRawUnsafe(`
      INSERT INTO "Project_Article_Scope" (project_id, article_id, publication_year)
      SELECT DISTINCT $1::bigint, a.article_id, a.publication_year
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
    console.log(`- Found ${kwIds.length} keywords for project ${projectId}...`);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "Project_Article_Scope" (project_id, article_id, publication_year)
      SELECT DISTINCT $1::bigint, a.article_id, a.publication_year
      FROM "Keyword_Article" ka
      JOIN "Article" a ON ka.article_id = a.article_id
      WHERE ka.keyword_id = ANY($2::bigint[])
      ON CONFLICT DO NOTHING;
    `, projectId, kwIds);
  }

  const countRes = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::text AS count FROM "Project_Article_Scope" WHERE project_id = $1
  `, projectId);

  console.log(`✅ Project ${projectId} sync complete! Scope articles: ${countRes[0]?.count || 0}`);
}

async function run() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node sync_scope.cjs <projectId|all>');
    process.exit(1);
  }

  try {
    if (arg.toLowerCase() === 'all') {
      const projects = await prisma.project.findMany({
        select: { project_id: true }
      });
      console.log(`Syncing all ${projects.length} projects...`);
      for (const p of projects) {
        await syncOneProject(p.project_id);
      }
    } else {
      await syncOneProject(BigInt(arg));
    }
  } catch (err) {
    console.error('❌ Error syncing:', err);
  } finally {
    await prisma.$disconnect();
  }
}

run();
