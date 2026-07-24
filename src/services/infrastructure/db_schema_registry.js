export const SCHEMA_REGISTRY = {
    "Article": {
        "table": "Article",
        "alias": "a",
        "primary_key": "article_id",
        "columns": [
            "article_id", "version", "issue_id", "title", "abstract", 
            "publication_year", "doi", "primary_topic", "semantic_scholar_id", 
            "citation_count", "semantic_influential_citation_count", 
            "semantic_external_ids", "semantic_tldr", "references", 
            "reference_count", "created_at", "is_deleted"
        ],
        "soft_delete": "a.is_deleted = false",
        "description": "Thông tin chi tiết về bài báo khoa học."
    },
    "Journal": {
        "table": "Journal",
        "alias": "j",
        "primary_key": "journal_id",
        "columns": [
            "journal_id", "source_id", "publisher_id", "country", "region", 
            "display_name", "type", "is_open_access", "is_oa_diamond", 
            "coverage", "issn", "is_deleted"
        ],
        "soft_delete": "j.is_deleted = false",
        "description": "Tạp chí khoa học."
    },
    "Publisher": {
        "table": "Publisher",
        "alias": "p",
        "primary_key": "publisher_id",
        "columns": ["publisher_id", "display_name", "is_deleted"],
        "soft_delete": "p.is_deleted = false",
        "description": "Nhà xuất bản tạp chí."
    },
    "Author": {
        "table": "Author",
        "alias": "au",
        "primary_key": "author_id",
        "columns": [
            "author_id", "orcid", "display_name", "url_image", "openalex_id", 
            "works_count", "cited_by_count", "h_index", "i10_index", "is_deleted"
        ],
        "soft_delete": "au.is_deleted = false",
        "description": "Tác giả của các nghiên cứu/bài báo."
    },
    "Institution": {
        "table": "Institution",
        "alias": "ins",
        "primary_key": "institution_id",
        "columns": ["institution_id", "display_name", "country", "type", "is_deleted"],
        "soft_delete": "ins.is_deleted = false",
        "description": "Tổ chức/đơn vị liên kết với tác giả."
    },
    "Subject_Area": {
        "table": "Subject_Area",
        "alias": "sa",
        "primary_key": "subject_area_id",
        "columns": ["subject_area_id", "display_name", "is_deleted"],
        "soft_delete": "sa.is_deleted = false",
        "description": "Lĩnh vực lớn."
    },
    "Subject_Category": {
        "table": "Subject_Category",
        "alias": "sc",
        "primary_key": "subject_category_id",
        "columns": ["subject_category_id", "subject_area_id", "display_name", "is_deleted"],
        "soft_delete": "sc.is_deleted = false",
        "description": "Chuyên ngành hẹp thuộc lĩnh vực lớn."
    },
    "Topic": {
        "table": "Topic",
        "alias": "t",
        "primary_key": "topic_id",
        "columns": ["topic_id", "subject_category_id", "display_name", "score", "is_deleted"],
        "soft_delete": "t.is_deleted = false",
        "description": "Chủ đề nghiên cứu thuộc một chuyên ngành."
    },
    "Sub_Topic": {
        "table": "Sub_Topic",
        "alias": "st",
        "primary_key": "sub_topic_id",
        "columns": ["sub_topic_id", "article_id", "topic_id", "score"],
        "soft_delete": null,
        "description": "Liên kết bài báo với các topic phụ."
    },
    "Keyword": {
        "table": "Keyword",
        "alias": "k",
        "primary_key": "keyword_id",
        "columns": ["keyword_id", "display_name", "is_deleted"],
        "soft_delete": "k.is_deleted = false",
        "description": "Từ khóa khoa học gắn với bài báo."
    },
    "Journal_Ranking": {
        "table": "Journal_Ranking",
        "alias": "jr",
        "primary_key": "journal_ranking_id",
        "columns": [
            "journal_ranking_id", "journal_id", "subject_category_id", "metric_id", 
            "year", "rank_position", "value_txt", "value_int", "value_float"
        ],
        "soft_delete": null,
        "description": "Lưu trữ chỉ số xếp hạng của Tạp chí theo năm như Quartile Q1-Q4 (value_txt), SJR (value_float), H-Index (value_int)."
    },
    "Ranking_Metric": {
        "table": "Ranking_Metric",
        "alias": "rm",
        "primary_key": "metric_id",
        "columns": ["metric_id", "code", "display_name", "metric_type", "description"],
        "soft_delete": null,
        "description": "Thông tin về chỉ số xếp hạng (QUARTILE, SJR, H-INDEX)."
    },
    "Volume": {
        "table": "Volume",
        "alias": "v",
        "primary_key": "volume_id",
        "columns": ["volume_id", "journal_id", "volume_number", "publication_year", "is_deleted"],
        "soft_delete": "v.is_deleted = false",
        "description": "Số/tập của Tạp chí."
    },
    "Issue": {
        "table": "Issue",
        "alias": "i",
        "primary_key": "issue_id",
        "columns": ["issue_id", "volume_id", "issue_number", "publication_year", "is_deleted"],
        "soft_delete": "i.is_deleted = false",
        "description": "Ấn bản phát hành của tạp chí."
    }
};

export const BRIDGE_TABLES = {
    "Author_Article": {
        "table": "Author_Article",
        "alias": "aa",
        "joins": {
            "Article": "aa.article_id = a.article_id",
            "Author": "aa.author_id = au.author_id"
        },
        "description": "Bảng trung gian liên kết bài viết và tác giả."
    },
    "Institution_Author": {
        "table": "Institution_Author",
        "alias": "ia",
        "joins": {
            "Institution": "ia.institution_id = ins.institution_id",
            "Author": "ia.author_id = au.author_id"
        },
        "description": "Bảng trung gian liên kết tổ chức và tác giả."
    },
    "Journal_Subject_Category": {
        "table": "Journal_Subject_Category",
        "alias": "jsc",
        "joins": {
            "Journal": "jsc.journal_id = j.journal_id",
            "Subject_Category": "jsc.subject_category_id = sc.subject_category_id"
        },
        "description": "Bảng liên kết tạp chí và chuyên ngành hẹp."
    },
    "Keyword_Article": {
        "table": "Keyword_Article",
        "alias": "ka",
        "joins": {
            "Keyword": "ka.keyword_id = k.keyword_id",
            "Article": "ka.article_id = a.article_id"
        },
        "description": "Bảng trung gian liên kết bài báo và từ khóa."
    }
};

// Sơ đồ liên kết đường đi giữa các bảng trong DB
export const JOIN_GRAPH = {
    "Article,Journal": `
        LEFT JOIN "Issue" AS i ON a.issue_id = i.issue_id
        LEFT JOIN "Volume" AS v ON i.volume_id = v.volume_id
        LEFT JOIN "Journal" AS j ON v.journal_id = j.journal_id
    `,
    "Article,Author": `
        JOIN "Author_Article" AS aa ON aa.article_id = a.article_id
        JOIN "Author" AS au ON au.author_id = aa.author_id
    `,
    "Author,Institution": `
        JOIN "Institution_Author" AS ia ON ia.author_id = au.author_id
        JOIN "Institution" AS ins ON ins.institution_id = ia.institution_id
    `,
    "Article,Keyword": `
        JOIN "Keyword_Article" AS ka ON ka.article_id = a.article_id
        JOIN "Keyword" AS k ON k.keyword_id = ka.keyword_id
    `,
    "Article,Topic": `
        LEFT JOIN "Topic" AS t ON t.topic_id = a.primary_topic
        LEFT JOIN "Sub_Topic" AS st ON st.article_id = a.article_id
    `,
    "Journal,Publisher": `
        JOIN "Publisher" AS p ON p.publisher_id = j.publisher_id
    `,
    "Journal,Journal_Ranking": `
        JOIN "Journal_Ranking" AS jr ON jr.journal_id = j.journal_id
        LEFT JOIN "Ranking_Metric" AS rm ON rm.metric_id = jr.metric_id
    `,
    "Journal,Subject_Category": `
        JOIN "Journal_Subject_Category" AS jsc ON jsc.journal_id = j.journal_id
        JOIN "Subject_Category" AS sc ON sc.subject_category_id = jsc.subject_category_id
        LEFT JOIN "Subject_Area" AS sa ON sa.subject_area_id = sc.subject_area_id
    `,
    "Subject_Category,Subject_Area": `
        LEFT JOIN "Subject_Area" AS sa ON sa.subject_area_id = sc.subject_area_id
    `,
    "Topic,Subject_Category": `
        JOIN "Subject_Category" AS sc ON sc.subject_category_id = t.subject_category_id
        LEFT JOIN "Subject_Area" AS sa ON sa.subject_area_id = sc.subject_area_id
    `
};
