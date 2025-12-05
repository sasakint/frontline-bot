// Discord.jsライブラリから必要なモジュールをインポートします
const { Client, GatewayIntentBits, Partials, Routes, REST, ApplicationCommandOptionType, ChannelType, EmbedBuilder } = require('discord.js'); // ★ ChannelTypeを追加
const { parse } = require('csv-parse/sync');

const express = require('express');
const app = express();

// --- ウェブスクレイピング関連のインポート ---
const axios = require('axios'); // LodestoneのHTMLを取得するために使用
const cheerio = require('cheerio'); // HTML解析に使用 // ★追加
// --- Firebase 関連のインポート ---
// CommonJS環境でのFirebase v9+のインポート方法に修正
const firebaseAppModule = require('firebase/app');
const firebaseFirestoreModule = require('firebase/firestore');

let userId = 'anonymous'; 
let isAuthReady = true;

// 関数をモジュールから抽出
const initializeApp = firebaseAppModule.initializeApp;
const { 
    getFirestore, 
    doc, 
    setDoc, 
    getDoc, 
    deleteDoc, 
    collection, 
    addDoc, 
    serverTimestamp,
    updateDoc, 
    getDocs, // 複数のドキュメントを取得するために追加
    query,
    orderBy,
    where, // ★where句を使用するためにインポート
} = firebaseFirestoreModule;

// Lodestone IDとユーザーを紐づけるコレクション名
const LINK_COLLECTION_NAME = 'lodestone_links'; // 紐づけ情報
const RESULT_COLLECTION_NAME = 'frontline_results'; // リザルト記録情報
const WATCHLIST_COLLECTION_NAME = 'frontline_watchlist'; // ★変更なし: ウォッチリスト情報
const STRATEGIST_REPORT_COLLECTION_NAME = 'strategist_reports'; // 軍師報告情報
const META_COLLECTION_NAME = 'meta_data'; // メタデータ保存用
const SUMMARY_COLLECTION_NAME = 'match_summaries';


// Botのメタデータ（アナウンス設定、リストメッセージIDなど）を保存する場所
const META_COLLECTION_ID = 'bot_meta';
const ANNOUNCEMENT_DOC_ID = 'announcement_state';
const WATCHLIST_DOC_ID = 'watchlist_message'; 
const FF14_COLOR_RED = 0xCF1E1E; // エラー用カラー
const FF14_COLOR_GREEN = 0x47ff47; // 緑 (成功、確認)
const FF14_COLOR_YELLOW = 0xFFFF00;
const FF14_COLOR_GRAY = 0x808080;

const TEAM_CODES = {
    'Maelstrom': '黒渦団', 
    'Twin Adders': '双蛇党', 
    'Immortal Flames': '不滅隊', 
};



// ----------------------------------------------------------------
// WARNING: 実際の運用時は、この設定情報を環境変数などから安全に読み込んでください。
// このオブジェクトにご自身のFirebaseプロジェクトの設定情報を貼り付けてください。
// ----------------------------------------------------------------
const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID, // Measurement IDは省略可能な場合があります
};
// ----------------------------------------------------------------

// Firebaseの初期化
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// Firestoreのメタデータドキュメント参照 (日次アナウンス用)
const metaDocRef = doc(db, META_COLLECTION_ID, ANNOUNCEMENT_DOC_ID);

// Firestoreのメタデータドキュメント参照 (ウォッチリスト用)
const watchlistMetaDocRef = doc(db, META_COLLECTION_ID, WATCHLIST_DOC_ID);


// Discordクライアントの初期化とインテント（ボットが受け取るイベント）の設定
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,           
        GatewayIntentBits.GuildMessages,    
        GatewayIntentBits.MessageContent,   
    ],
    partials: [Partials.Message, Partials.Channel],
});

// Discord Bot TokenとClientID
const token = process.env.DISCORD_BOT_TOKEN;
const clientId = '1443955344081555458'; // ★ご指定いただいた正しいクライアントIDに修正しました
// ----------------------------------------------------------------

/**
 * 初回呼び出し時にFirebaseを初期化し、Firestoreインスタンスを返す
 * @returns {Firestore} Firestoreインスタンス
 */
function getFirestoreLazy() {
    // すでに初期化済みであれば、そのままFirestoreインスタンスを返す
    if (firebaseApp && isAuthReady) {
        return getFirestore(firebaseApp);
    }
    
    // 未初期化の場合、環境変数を使って初期化する
    const firebaseConfig = {
        apiKey: process.env.FIREBASE_API_KEY,
        authDomain: process.env.FIREBASE_AUTH_DOMAIN,
        projectId: process.env.FIREBASE_PROJECT_ID,
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
        messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
        appId: process.env.FIREBASE_APP_ID,
        measurementId: process.env.FIREBASE_MEASUREMENT_ID, 
    };

    try {
        firebaseApp = initializeApp(firebaseConfig);
        isAuthReady = true;
        console.log('--- LAZY SUCCESS: Firebase 遅延初期化完了 ---');
        return getFirestore(firebaseApp);
    } catch (error) {
        console.error('--- LAZY FATAL: Firebase 初期化失敗 ---', error.message);
        // 初期化失敗時はFirestoreインスタンスを返さず、後続処理でエラーを発生させる
        throw new Error("Firebaseの環境設定が不正です。Renderの環境変数を確認してください。");
    }
}

/**
 * 試合概要をFirestoreに保存する
 * @param {Object} summaryData - 試合概要データ
 * @returns {Promise<string>} 割り当てられた試合ID (docId)
 */
async function storeMatchSummary(summaryData) {
    // getFirestore, collection, addDoc, serverTimestamp は
    // ファイルの冒頭でインポートされている必要があります。
    const db = getFirestoreLazy();
    const docRef = await addDoc(collection(db, SUMMARY_COLLECTION_NAME), {
        ...summaryData,
        timestamp: serverTimestamp(),
    });
    return docRef.id;
}

// --- ジョブの選択肢定義 ---
const JOB_CHOICES = [
    { name: 'ナイト (PLD)', value: 'PLD' },
    { name: '戦士 (WAR)', value: 'WAR' },
    { name: '暗黒騎士 (DRK)', value: 'DRK' },
    { name: 'ガンブレイカー (GNB)', value: 'GNB' },
    // ヒーラー
    { name: '白魔道士 (WHM)', value: 'WHM' },
    { name: '学者 (SCH)', value: 'SCH' },
    { name: '占星術師 (AST)', value: 'AST' },
    { name: '賢者 (SGE)', value: 'SGE' },
    // メレーDPS
    { name: 'モンク (MNK)', value: 'MNK' },
    { name: '竜騎士 (DRG)', value: 'DRG' },
    { name: '忍者 (NIN)', value: 'NIN' },
    { name: '侍 (SAM)', value: 'SAM' },
    { name: 'リーパー (RPR)', value: 'RPR' },
    { name: 'ヴァイパー (VPR)', value: 'VPR' }, 
    // レンジDPS
    { name: '吟遊詩人 (BRD)', value: 'BRD' },
    { name: '機工士 (MCH)', value: 'MCH' },
    { name: '踊り子 (DNC)', value: 'DNC' },
    // キャスターDPS
    { name: '黒魔道士 (BLM)', value: 'BLM' },
    { name: '召喚士 (SMN)', value: 'SMN' },
    { name: '赤魔道士 (RDM)', value: 'RDM' },
    { name: 'ピクトマンサー (PCT)', value: 'PCT' }, 
];

// --- ジョブコードに対応する絵文字のマップ ---
const JOB_EMOJIS = {
    'PLD': '🛡️', 'WAR': '🪓', 'DRK': '⚫', 'GNB': '💥', 
    'WHM': '🌸', 'SCH': '🧚', 'AST': '🔮', 'SGE': '🟢', 
    'MNK': '👊', 'DRG': '🐉', 'NIN': '🥷', 'SAM': '🔪', 
    'RPR': '💀', 'VPR': '🐍', 'BRD': '🏹', 'MCH': '🔫', 
    'DNC': '💃', 'BLM': '🧙‍♀️', 'SMN': '🦄', 'RDM': '🗡️', 
    'PCT': '🎨', 
};


// --- フロントライン・ローテーションの定義 ---
const FRONTLINE_ROTATION = [
    { name: '外縁遺跡群（制圧戦）', short: '制圧戦' }, // Index 0
    { name: 'シールロック（争奪戦）', short: '争奪戦' },    // Index 1
    { name: 'フィールド・オブ・グローリー（砕氷戦）', short: '砕氷戦' }, // Index 2
    { name: 'オンサル・ハカイル（終節戦）', short: '終節戦' }  // Index 3
];

/**
 * 整形されたACTデータをFirestoreに保存する関数
 * @param {Object} data - parseActDataから返された集計済みデータ
 * @returns {Promise<{successCount: number, failCount: number}>}
 */
async function storeDataToFirestore(data) {
    let successCount = 0;
    let failCount = 0;
    const db = getFirestoreLazy(); // FirebaseのgetFirestoreLazy();関数が利用可能であると仮定

    // キャラクターごとにデータを保存するループ
    for (const [name, record] of Object.entries(data)) {
        try {
            // Firestoreへの保存処理（例: 'frontline_results'コレクションに保存）
            await addDoc(collection(db, RESULT_COLLECTION_NAME), {
                // ★★★ 修正箇所: スプレッド構文 (...) を使用して、parseActDataからの全フィールドを格納 ★★★
                ...record, 
                // timestampはparseActDataで付与したrecordedAtではなく、Firestoreのサーバータイムスタンプを使用
                timestamp: serverTimestamp(), 
            });
            successCount++;
        } catch (e) {
            console.error(`Firestore保存エラー (${name}):`, e);
            // エラーが発生した場合、どのデータに問題があったかを表示
            console.error(`  - エラー発生レコード（抜粋）: name=${record.name}, job=${record.job}, rank=${record.rank}`);
            failCount++;
        }
    }

    return { successCount, failCount };
}

/**
 * データベースから指定された軍師の戦績を抽出し、集計・表示します。
 * @param {string} targetStrategistName - 検索対象の軍師名（例: 'Taro Yamada'）。頭文字は大文字化済み。
 */
async function strategistSearchCommand(targetStrategistName) {
    
    // 1. データベースから指定された軍師のレコードのみを取得
    const db = getFirestoreLazy();
    const resultsCol = collection(db, RESULT_COLLECTION_NAME);
    
    // ACT記録ドキュメントから、名前と軍師フラグで検索
    const q = query(
        resultsCol,
        where('isStrategist', '==', true), 
        where('name', '==', targetStrategistName) // 頭文字大文字化されたフルネームで検索
    );

    const snapshot = await getDocs(q);
    const strategistRecords = snapshot.docs.map(doc => doc.data());

    if (strategistRecords.length === 0) {
        return { content: `🔍 **軍師「${targetStrategistName}」の戦績は見つかりませんでした。** 名前を確認するか、/act_record コマンドで記録されているか確認してください。` };
    }

    // 2. 統計の集計
    let totalWins = 0;
    let totalDPS = 0;
    // ★ 修正点: rankCountsのキーを明示的に文字列で初期化
    const rankCounts = { '1': 0, '2': 0, '3': 0 }; 
    const jobCounts = {};
    const totalReports = strategistRecords.length;

    strategistRecords.forEach(record => {
        // 順位の集計ロジックを修正
        const rankValue = String(record.rank).trim(); // 確実に文字列として取得し、前後の空白を削除
        const numericRank = parseInt(rankValue); // 数値に変換
        
        // 1, 2, 3 のいずれかであるかチェック
        if (numericRank === 1 || numericRank === 2 || numericRank === 3) {
            // ★ 修正点: rankCountsへのアクセスを文字列キー ('1', '2', '3') に統一
            const rankKey = String(numericRank); 
            
            rankCounts[rankKey] = (rankCounts[rankKey] || 0) + 1;
            
            if (numericRank === 1) {
                totalWins++;
            }
        }
        
        // DPSの合計
        totalDPS += parseFloat(record.dps) || 0; 
        
        // ジョブのカウント
        const job = record.job || '不明';
        jobCounts[job] = (jobCounts[job] || 0) + 1;
    });

    // 3. 最終処理と最多ジョブの特定
    const winRate = (totalReports === 0) ? 0 : (totalWins / totalReports) * 100;
    const avgDPS = (totalReports === 0) ? 0 : totalDPS / totalReports;

    let mostUsedJob = '不明';
    let maxCount = 0;
    for (const job in jobCounts) {
        if (jobCounts[job] > maxCount) {
            maxCount = jobCounts[job];
            mostUsedJob = job;
        }
    }
    const mostUsedJobCode = mostUsedJob.toUpperCase();
    const mostUsedJobEmoji = JOB_EMOJIS[mostUsedJobCode] || '❓';
    
    // 4. Embedの作成
    const formatNumber = (num) => (typeof num === 'number' ? num.toLocaleString() : num);
    const winPerc = winRate.toFixed(2);
    const avgDPSFormatted = formatNumber(Math.round(avgDPS));
    
    let color = 0xAAAAAA; // FF14_COLOR_GRAYの代替
    if (typeof FF14_COLOR_GREEN !== 'undefined') {
        if (winRate >= 50) {
            color = FF14_COLOR_GREEN; 
        } else if (winRate >= 33.33) {
            color = FF14_COLOR_YELLOW;
        } else {
            color = FF14_COLOR_RED;
        }
    }


    const embed = new EmbedBuilder()
        .setColor(color) 
        .setTitle(`🏆 軍師 戦績レポート: ${targetStrategistName}`)
        .setDescription(`総記録回数: **${totalReports} 回**`)
        .addFields(
            { 
                name: '⚔️ 最重要指標', 
                value: `**総勝利回数:** ${totalWins} 回\n**勝率:** \`${winPerc}%\``, 
                inline: true 
            },
            { 
                name: '💡 ジョブ/火力', 
                value: `**最多ジョブ:** ${mostUsedJobEmoji} [${mostUsedJob}] (${maxCount}回)\n**平均DPS:** \`${avgDPSFormatted}\``, 
                inline: true 
            },
            { name: '\u200B', value: '\u200B', inline: false }, // 空行用
            // ★ 修正点: 文字列キーでアクセスするように変更
            { name: '🥇 1位', value: `${rankCounts['1']} 回`, inline: true },
            { name: '🥈 2位', value: `${rankCounts['2']} 回`, inline: true },
            { name: '🥉 3位', value: `${rankCounts['3']} 回`, inline: true }
        )
        .setFooter({ text: '記録はACTデータに基づきます。' })
        .setTimestamp();
    
    return { embeds: [embed] };
}

/**
 * JST 0:00を基準に、今日のフロントラインマップを計算します。
 * @returns {{name: string, short: string}} 現在開催中のマップ情報
 */
function getCurrentFrontlineMap() {
    // 基準日: 2023年12月28日 00:00:00 JST を Index 0 (制圧戦) の開始日とする
    // ユーザーからの報告に基づき、計算ズレ（+2日）を解消するため、基準日をさらに2日前に修正しました。
    const JST_EPOCH_MS = Date.UTC(2023, 11, 27, 15, 0, 0, 0); // 12/28 JST 0:00 に調整
    
    const now = new Date();
    
    // 1日のミリ秒数
    const MS_PER_DAY = 86400000;
    
    // JSTのオフセット（9時間 = 9 * 60 * 60 * 1000 ms）
    const JST_OFFSET_MS = 9 * 3600000; 
    
    // 現在のUTC時刻にJSTオフセットを加算し、JSTの0時を基準として経過時間を計算します。
    const nowJstZeroed = now.getTime() + JST_OFFSET_MS; 

    // 基準日からJST時刻で何日経過したか
    const daysPassed = Math.floor((nowJstZeroed - JST_EPOCH_MS) / MS_PER_DAY);
    
    const rotationIndex = daysPassed % FRONTLINE_ROTATION.length;
    
    return FRONTLINE_ROTATION[rotationIndex];
}
// -----------------------------------------------------------------

/**
 * Discord User IDからリンクされたキャラクター名を取得する
 * @param {string} userId - DiscordユーザーID
 * @returns {Promise<string|null>} キャラクター名
 */
async function getCharacterNameByUserId(userId) {
    // 【重要】関数内で const db = getFirestoreLazy(); を書かないでください！
    // グローバルの db 変数を使います。
    
    const docRef = doc(db, LINK_COLLECTION_NAME, userId); 
    try {
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            const data = docSnap.data();
            // charName または characterName どちらか入っている方を返します
            return data.charName || data.characterName || null; 
        }
        return null;
    } catch (e) {
        console.error("キャラクター名取得エラー:", e);
        return null;
    }
}

/**
 * ACTサマリーデータをパースし、rank情報を付与して整形する
 * @param {string} csvText - アップロードされたACTのCSVテキストデータ
 * @param {string} rank - メッセージから取得した試合の順位 (例: "1", "2", "3")
 * @returns {Object<string, Object>} - キャラクター名ごとの整形されたデータオブジェクト
 */
function parseActData(csvText, rank) {
    // ACTのサマリーデータは通常カンマ区切り（CSV）
    const records = parse(csvText, {
        columns: true, // ヘッダー行を読み取り、オブジェクトのキーとして使用
        skip_empty_lines: true
    });

    const characterData = {};

    for (const record of records) {
        const name = record.Name;
        if (!name) continue;

        // 【変更点2】 rank情報の付与ルールに従い、順位を設定
        let resultRank;
        if (record.Ally === 'T') {
            // AllyがT (Target: 敵) の場合、ユーザーが入力したrankを付与
            resultRank = rank;
        } else if (record.Ally === 'F') {
            // AllyがF (Friendly: 味方) の場合、Noneを設定
            resultRank = 'None';
        } else {
            resultRank = 'Unknown';
        }

        // 2. データベース格納用にデータを整形
        // ACTのCSVはすべて文字列なので、必要な項目を数値に変換する
        const dataToStore = {
            // 基本情報
            encId: record.EncId,
            ally: record.Ally,
            name: name,
            job: record.Job,
            duration: parseFloat(record.Duration || 0),

            // PvP/戦闘指標 (文字列から数値へ変換)
            damage: parseFloat(record.Damage || 0),
            dps: parseFloat(record.DPS || 0),
            kills: parseInt(record.Kills || 0, 10),
            deaths: parseInt(record.Deaths || 0, 10),
            healed: parseFloat(record.Healed || 0),
            healsTaken: parseFloat(record.HealsTaken || 0),
            damageTaken: parseFloat(record.DamageTaken || 0),
            // %表記を削除し、数値として格納
            overHealPct: parseFloat(record.OverHealPct.replace('%', '') || 0), 

            // メタデータ
            // 【変更点3】 新たにrank情報をデータに追加
            rank: resultRank, 
            recordedAt: new Date().toISOString(),
        };

        // キャラクター名ごとにデータを集約（同じ名前のデータが複数ある場合は上書き）
        characterData[name] = dataToStore;
    }

    return characterData;
}

// --- 🔥 ロール管理用のカラーコードと関数定義 ---

/**
 * Discordのカラーコードを16進数の数値で定義
 */
const FF14_COLOR_GOLD = 0xFFC832; // FFXIVっぽいゴールド (255, 200, 50)
const FF14_COLOR_BLUE = 0x116BDD; // FFXIVっぽいロゴブルー (17, 107, 189)

/**
 * ACTサマリーデータ（CSV）をパースし、試合順位（rank）情報を付与して整形する
 * @param {string} csvText - アップロードされたACTのCSVテキストデータ
 * @param {number} rank - メッセージから取得した試合の順位 (1, 2, 3)
 * @returns {Object<string, Object>} - キャラクター名ごとの整形されたデータオブジェクト
 */
function parseActData(actData) { // ★ 引数から allianceRank を削除 ★
    if (!actData) {
        return {}; 
    }

    let records = [];
    const aggregatedData = {}; 

    try {
        // --- 1. CSVデータのパース（同期処理） ---
        records = parse(actData, {
            columns: true,
            skip_empty_lines: true,
            delimiter: ',',
        });
        
    } catch (error) {
        console.error("ACTデータのパース中にエラーが発生しました:", error);
        return {}; 
    }
    
    if (records.length === 0) return {};
    
    // --- 2. 全フィールドの集計と整形ロジック (lowercase化とundefined排除) ---

    // 必須ヘッダーのチェック
    const requiredHeaders = ['Name', 'Job', 'Damage'];
    const headers = Object.keys(records[0] || {});
    const hasRequiredHeaders = requiredHeaders.every(header => headers.includes(header));
    if (!hasRequiredHeaders) {
         console.error("【診断-パース】必須のACTヘッダーが見つかりませんでした。");
         return {}; 
    }

    for (const record of records) {
        // NameとJobが実在するプレイヤーやエンティティであることを確認
        if (!record.Name || !record.Job || record.Name === 'Limit Break') {
             continue; // Limit Breakや無効な行はスキップ
        }

        const nameKey = record.Name;
        const cleanedRecord = {};
        
        // --- 変換するフィールドの定義 ---
        const integerFields = ['duration', 'damage', 'kills', 'healed', 'heals', 'powerdrain', 'powerreplenish', 'hits', 'crithits', 'blocked', 'misses', 'swings', 'healstaken', 'damagetaken', 'deaths', 'threatdelta', 'directhitcount', 'critdirecthitcount'];
        const floatFields = ['dps', 'encdps', 'enchps', 'damageperc', 'healedperc', 'tohit', 'critdamperc', 'crithealperc', 'parrypct', 'blockpct', 'inctohit', 'overhealpct', 'directhitpct', 'critdirecthitpct'];
        
        // 全フィールドをループし、キーを小文字に変換し、値を整形
        for (const [key, value] of Object.entries(record)) {
            const lowerKey = key.toLowerCase(); // キーを小文字に変換

            // undefined, null, '--' はFirestoreでエラーになるため、空文字列に変換
            if (value === undefined || value === null || value === '--') {
                cleanedRecord[lowerKey] = ''; 
                continue;
            }

            const stringValue = value.toString();

            if (integerFields.includes(lowerKey)) {
                cleanedRecord[lowerKey] = parseInt(stringValue, 10) || 0;
            } 
            else if (floatFields.includes(lowerKey)) {
                const cleanedValue = stringValue.replace(/%|-+/g, '');
                cleanedRecord[lowerKey] = parseFloat(cleanedValue) || 0.0; 
            }
            else {
                // その他のフィールド（文字列など）はそのまま
                cleanedRecord[lowerKey] = stringValue;
            }
        }
        
        // parseActDataでは rank/team のタグ付けは行わず、actRecordCommand側で行う
        aggregatedData[nameKey] = {
            ...cleanedRecord, 
            rank: 'N/A', // 一旦ダミーでN/A
            team: 'N/A', // 一旦ダミーでN/A
        };
    }

    return aggregatedData;
}
/**
 * ACTデータ処理、Firestoreへの保存、結果Embedの作成を行うメインロジック
 * @param {string} userId - コマンド実行者のDiscordユーザーID
 * @param {string} myTeam - 自分の所属アライアンス ('Maelstrom'など)
 * @param {number} mPoint - 黒渦団ポイント
 * @param {number} tPoint - 双蛇党ポイント
 * @param {number} iPoint - 不滅隊ポイント
 * @param {number} myKills - 自分のキル数
 * @param {number} myAssists - 自分のアシスト数
 * @param {string} attachmentContent - ACT CSV/TXT ファイルの内容
 * @returns {Promise<Object>} Discordに返すメッセージオブジェクト
 */
/**
 * ACTデータ処理、Firestoreへの保存、結果Embedの作成を行うメインロジック
 */
async function actRecordCommand(userId, myTeam, mPoint, tPoint, iPoint, myKills, myAssists, attachmentContent, strategistFirst, strategistLast) {
    
    // 1. 自分のキャラクター名を取得
    const myCharacterName = await getCharacterNameByUserId(userId);

    // ★★★ 軍師名を作成 ★★★
    let strategistName = null;
    if (strategistFirst && strategistLast) {
        // 例: 'Taro Yamada'
        strategistName = `${strategistFirst} ${strategistLast}`;
        console.log(`【デバッグ】軍師名が指定されました: ${strategistName}`);
    } else if (strategistFirst || strategistLast) {
        // 片方だけ入力された場合は警告
        console.warn(`【警告】軍師の姓または名が片方だけ入力されました。軍師情報は無視されます。`);
    }

    if (!myCharacterName) {
        console.warn(`【警告】ユーザーID ${userId} のキャラ名が取得できませんでした。/link済みか確認してください。`);
    } else {
        console.log(`【デバッグ】YOU変換対象のキャラ名: ${myCharacterName}`);
    }
    
    // --- 2. 試合のポイントと順位を決定 ---
    const teamPoints = [
        { team: 'Maelstrom', points: mPoint, name: '黒渦団' },
        { team: 'Twin Adders', points: tPoint, name: '双蛇党' },
        { team: 'Immortal Flames', points: iPoint, name: '不滅隊' },
    ].sort((a, b) => b.points - a.points); 

    const pointsMap = {};
    let rankCounter = 1;
    let prevPoints = -1;
    teamPoints.forEach((p, index) => {
        if (p.points !== prevPoints) { rankCounter = index + 1; }
        pointsMap[p.team] = { rank: rankCounter, points: p.points, name: p.name };
        prevPoints = p.points;
    });

    // ポイントに基づいてフィールド名を決定
    const fieldName = determineFieldByScore(teamPoints[0].points);
    console.log(`[デバッグ] 優勝ポイント: ${teamPoints[0].points}, 判定フィールド: ${fieldName}`);


    // --- 3. 試合概要の保存 ---
    const rawRecords = parse(attachmentContent, { columns: true, skip_empty_lines: true, delimiter: ',' });
    const durationValues = rawRecords.map(r => parseInt(r.Duration)).filter(d => !isNaN(d) && d > 0);
    const estimatedDuration = durationValues.length > 0 ? Math.max(...durationValues) : null;
    
    const summaryData = {
        field: fieldName,
        myTeam: TEAM_CODES[myTeam] || myTeam,
        points: { Maelstrom: mPoint, TwinAdders: tPoint, ImmortalFlames: iPoint },
        ranking: teamPoints.map(p => ({ team: p.team, name: p.name, rank: pointsMap[p.team].rank, points: p.points })),
        estimatedDuration: estimatedDuration,
        recordedBy: userId,
    };
    const matchId = await storeMatchSummary(summaryData);

    // --- 4. ACTデータの処理と「YOU」の変換 ---
    const parsedData = parseActData(attachmentContent); 
    let processedData = {}; 

    for (const [name, record] of Object.entries(parsedData)) {
        let keyName = name;
        const nameNormalized = name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase(); 
        const isYou = nameNormalized === 'YOU';
        
        // 変換条件: 'Ally: T'
        if (myCharacterName && isYou && record.ally === 'T') {
            keyName = myCharacterName;     
            record.name = myCharacterName; 
            console.log(`【変換成功】ACTデータの 'YOU' (Ally: T) を '${myCharacterName}' に置き換えました。`);
        }
        
        processedData[keyName] = record;
    }

    // --- 5. データベースへの保存とチーム・ランク付与/軍師フラグ追加 ---
    let successCount = 0;
    let failCount = 0;
    let myRecord = null; 
    let strategistRecord = null; // 軍師のレコードを格納する変数

    for (const [name, record] of Object.entries(processedData)) { 
        // ★★★ isStrategist フィールドを初期化 ★★★
        let finalRecord = { ...record, matchId: matchId, userId: userId, isStrategist: false }; 

        // 自分のキャラかどうか判定 (変換後の名前でチェック)
        const isMyCharacter = myCharacterName && (name === myCharacterName);
        
        // ★★★ 軍師かどうか判定 ★★★
        const isStrategist = strategistName && (name === strategistName);

        if (isMyCharacter) {
            // 自分 (Ally: T)
            finalRecord.kills = myKills;
            finalRecord.assists = myAssists;
            finalRecord.team = TEAM_CODES[myTeam]; 
            finalRecord.rank = pointsMap[myTeam].rank;
            myRecord = finalRecord; 
            console.log(`【上書き】自分(${name})の戦績を更新: K${myKills}/A${myAssists}`);

        } else if (finalRecord.ally === 'T') {
            // 他の味方(T)
            finalRecord.team = TEAM_CODES[myTeam];
            finalRecord.rank = pointsMap[myTeam].rank;
            
        } else if (finalRecord.ally === 'F') {
            // 敵(F)
            finalRecord.team = 'None';
            finalRecord.rank = 'None';

        } else {
            // その他
            finalRecord.team = 'None';
            finalRecord.rank = 'None';
        }
        
        // ★★★ 軍師フラグを設定し、レコードを記憶 ★★★
        if (isStrategist) {
            finalRecord.isStrategist = true;
            strategistRecord = finalRecord;
            console.log(`【軍師特定】軍師 ${name} のレコードにフラグを設定しました。`);
        }


        try {
            await addDoc(collection(getFirestoreLazy(), RESULT_COLLECTION_NAME), finalRecord);
            successCount++;
        } catch (e) {
            console.error(`保存エラー (${name}):`, e);
            failCount++;
        }
    }

    // --- 6. 結果Embedの作成 ---
    const formatNumber = (num) => (typeof num === 'number' ? num.toLocaleString() : num);

    // damageが0より大きいレコードのみを対象
    const allPlayersArray = Object.values(processedData)
        .filter(p => p.damage > 0 && p.name && p.job) 
        // データベースに保存したレコードからisStrategist情報を反映させる
        .map(p => ({ ...p, isStrategist: (strategistRecord && p.name === strategistRecord.name) ? true : false })) 
        .sort((a, b) => b.damage - a.damage); // 与ダメ(Damage)でソート

    // 自分のレコードをランキングから除外したリスト
    const rankPlayers = allPlayersArray.filter(p => !myCharacterName || p.name !== myCharacterName);

    const topPlayers = rankPlayers.slice(0, Math.min(rankPlayers.length, 8));

    const embed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setTitle(`✅ ACTフロントライン記録完了 (${fieldName})`)
        .setDescription(`**試合ID:** \`${matchId}\`\n**自分のチーム:** ${TEAM_CODES[myTeam] || myTeam} (${pointsMap[myTeam].rank}位) \n\n戦闘記録を**${successCount}名**について登録しました。`)
        .addFields(
            { name: '🥇 1位', value: `${teamPoints[0].name} (${teamPoints[0].points}pt)`, inline: true },
            { name: '🥈 2位', value: `${teamPoints[1].name} (${teamPoints[1].points}pt)`, inline: true },
            { name: '🥉 3位', value: `${teamPoints[2].name} (${teamPoints[2].points}pt)`, inline: true }
        )
        .setTimestamp()
        .setFooter({ text: `記録者: ${myCharacterName || userId} | 試合時間: ${estimatedDuration || '不明'}秒 | データベースに格納済み` });
        
    // 注釈の変更
    const footnote = "\n\n⚠️ **注釈:** フィールドは優勝チームのポイントに基づいて自動判定しています。";
    embed.setDescription(embed.data.description + footnote);
        
    // ★★★ 軍師情報エリアを追加 ★★★
    if (strategistRecord) {
        const strategistJobCode = strategistRecord.job.toUpperCase(); 
        const strategistEmoji = JOB_EMOJIS[strategistJobCode] || '❓';
        embed.addFields({
            name: `────────────────────`,
            value: `**👑 軍師: ${strategistRecord.name} ${strategistEmoji} [${strategistRecord.job}]**`,
            inline: false
        });
    }

    // 自分の情報
    if (myRecord) {
        const myJobCode = myRecord.job.toUpperCase(); 
        const myEmoji = JOB_EMOJIS[myJobCode] || '❓';
        const myDps = formatNumber(Math.round(myRecord.dps) || 0);

        embed.addFields({
            name: `────────────────────`,
            value: `**👑 あなたの戦績 (${myRecord.name} ${myEmoji} [${myRecord.job}])**`,
            inline: false
        });
        embed.addFields({
            name: `キル/アシスト`,
            value: `**K:** ${myRecord.kills} / **A:** ${myRecord.assists}`,
            inline: true
        });
        embed.addFields({
            name: `与ダメージ / DPS`,
            value: `**Dmg:** ${formatNumber(myRecord.damage)} / **DPS:** ${myDps}`,
            inline: true
        });
        embed.addFields({
            name: `被ダメージ / デス`,
            value: `**被Dmg:** ${formatNumber(myRecord.damagetaken)} / **Death:** ${myRecord.deaths}`,
            inline: true
        });
        embed.addFields({ name: '\u200b', value: '**⚔️ 全員与ダメージランキング TOP 8**', inline: false }); 
    } else {
        embed.addFields({ name: '\u200b', value: '**⚔️ 全員与ダメージランキング TOP 8**', inline: false }); 
    }
        
    // ランキング情報の追加
    topPlayers.forEach((player, index) => {
        const dps = formatNumber(Math.round(player.dps) || 0); 
        const jobCode = player.job.toUpperCase(); 
        const emoji = JOB_EMOJIS[jobCode] || '❓'; 
        
        let allyMark = player.ally === 'T' ? '🟢' : (player.ally === 'F' ? '🔴' : '⚪');
        
        // ★★★ 軍師マークを追加 ★★★
        if (player.isStrategist) {
            allyMark = '🚩'; 
        }

        embed.addFields({
            name: `${allyMark} ${index + 1}. ${player.name} ${emoji} [${player.job}] (DPS: ${dps})`,
            value: `**与ダメ:** ${formatNumber(player.damage)} | **被ダメ:** ${formatNumber(player.damagetaken)} | **デス:** ${player.deaths}`,
            inline: false
        });
    });

    return { embeds: [embed] };
}

/**
 * 指定された名前のロールをギルド内で検索し、存在しない場合は作成します。
 * @param {import('discord.js').Guild} guild 
 * @param {string} roleName 
 * @param {number} color ロールの色の16進数値
 * @returns {Promise<import('discord.js').Role | null>}
 */
async function findOrCreateRole(guild, roleName, color) {
    // キャッシュからロール名で検索
    let role = guild.roles.cache.find(r => r.name === roleName);

    if (!role) {
        console.log(`ロール '${roleName}' が見つかりません。新しく作成します。`);
        try {
            // ロールが存在しない場合は作成
            role = await guild.roles.create({
                name: roleName,
                color: color,
                permissions: [], // 権限なし
                reason: "Lodestone連携によるロールの自動作成"
            });
            console.log(`ロール '${roleName}' を作成しました。`);
        } catch (error) {
            console.error(`エラー: ロール '${roleName}' の作成に失敗しました。Botの権限を確認してください:`, error);
            return null;
        }
    }
    return role;
}

/**
 * 指定されたメンバーに、キャラクター名ロールと共通の 'ff14' ロールを付与します。
 * @param {import('discord.js').GuildMember} member
 * @param {string} characterName
 * @returns {Promise<string[] | null>} 付与したロール名の配列。失敗した場合はnull。
 */
async function assignCharacterRoles(member, characterName) {
    const rolesToAssign = [];
    const guild = member.guild;

    // --- 1. キャラクター名ロールの処理 ---
    const charRole = await findOrCreateRole(guild, characterName, FF14_COLOR_GOLD);
    if (charRole && !member.roles.cache.has(charRole.id)) {
        rolesToAssign.push(charRole);
    }

    // --- 2. 'ff14' 共通ロールの処理 ---
    const ff14Role = await findOrCreateRole(guild, "ff14", FF14_COLOR_BLUE);
    if (ff14Role && !member.roles.cache.has(ff14Role.id)) {
        rolesToAssign.push(ff14Role);
    }

    // --- 3. ロールの付与実行 ---
    if (rolesToAssign.length === 0) {
        console.log(`メンバー ${member.user.tag} に付与すべき新しいロールはありませんでした。`);
        return [];
    }

    try {
        // ロールを一括付与
        await member.roles.add(rolesToAssign, "Lodestone連携によるキャラクター名とFF14共通ロールの自動付与");
        
        const roleNames = rolesToAssign.map(r => r.name);
        console.log(`メンバー ${member.user.tag} にロール ${roleNames.join(', ')} を付与しました。`);
        return roleNames; // 付与したロール名を返却

    } catch (error) {
        console.error("ロール付与中にエラーが発生しました。Botのロールの順位を確認してください:", error);
        return null; // 失敗を通知
    }
}

/**
 * キャラクター専用のプライベートテキストチャンネルを検索し、存在しない場合は作成します。
 * チャンネルには、該当するキャラクター名ロールを持つユーザーのみがアクセスできるよう権限を設定します。
 * @param {import('discord.js').Guild} guild 
 * @param {string} characterName 
 * @param {import('discord.js').Role} characterRole 
 * @param {import('discord.js').User} user
 * @returns {Promise<import('discord.js').TextChannel | null>}
 */
async function findOrCreatePrivateCharacterChannel(guild, characterName, characterRole, user) {
    // Discordチャンネル名は小文字、ハイフン区切りにサニタイズされます。
    // ユーザーの要望の見た目 '🔑 Zist Tor' に近づけるため、チャンネル名の先頭に絵文字を含めます。
    const channelName = `🔑-${characterName}`.toLowerCase().replace(/\s+/g, '-');
    const displayChannelName = `🔑 ${characterName}`; // 返信メッセージで使用する表示名

    // 既存チャンネルを検索 (名前は小文字でハイフン区切りになるため、それに合わせる)
    // ChannelType.GuildText (0) はテキストチャンネルを意味します。
    let channel = guild.channels.cache.find(c => c.name === channelName && c.type === ChannelType.GuildText);

    if (!channel) {
        console.log(`プライベートチャンネル '${channelName}' が見つかりません。新しく作成します。`);
        try {
            // 権限オーバーライドの設定
            const permissionOverwrites = [
                // 1. @everyone: 閲覧拒否 (デフォルトでプライベートにする)
                {
                    id: guild.id,
                    deny: ['ViewChannel'],
                },
                // 2. キャラクター名ロール: 閲覧許可
                {
                    id: characterRole.id,
                    allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'],
                },
                // 3. Bot自身: 閲覧許可 (Botがメッセージを送信できるようにするため)
                {
                    id: user.client.user.id,
                    allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'],
                }
            ];

            // チャンネルの作成
            channel = await guild.channels.create({
                name: channelName, 
                type: ChannelType.GuildText,
                topic: `${characterName} 専用のフロントライン記録・メモ用プライベートチャンネルです。`,
                permissionOverwrites: permissionOverwrites,
                reason: "Lodestone連携によるキャラクター専用プライベートチャンネルの自動作成",
            });
            
            console.log(`プライベートチャンネル '${channelName}' を作成し、ロール権限を設定しました。`);

            // 初回メッセージを送信
            if (channel && channel.isTextBased()) {
                await channel.send({
                    content: `🎉 ${characterRole.toString()} さんへようこそ！\n` +
                             `ここは、あなた専用のプライベートチャンネル（**${displayChannelName}**）です。\n` +
                             `このチャンネルは、**${characterRole.name}** ロールを持っているメンバー（あなた自身）とサーバー管理者だけが見ることができます。\n` +
                             `フロントラインのリザルト記録やメモにご活用ください。`
                });
            }

        } catch (error) {
            console.error(`エラー: プライベートチャンネル '${channelName}' の作成に失敗しました。Botの権限を確認してください:`, error);
            return null;
        }
    }
    return channel;
}
// -----------------------------------------------------------------


// --- 🔥 日次自動アナウンスのスケジューリングと実行ロジック ---
/**
 * 毎日0:00 JSTにアナウンスを実行するスケジューラを起動します。が、うまくいってないです
 */
function startDailyScheduler() {
    // 1. 次のJST 0:00までの時間を計算
    const now = new Date();
    const MS_PER_DAY = 86400000;
    const JST_OFFSET_MS = 9 * 3600000; 

    // 現在のUTC時刻 (ms)
    const currentUtcMs = now.getTime();
    
    // JSTの「今日」の0時がUTCで何時か
    const todayJstMidnightUtcMs = Math.floor((currentUtcMs + JST_OFFSET_MS) / MS_PER_DAY) * MS_PER_DAY - JST_OFFSET_MS;
    
    // JSTの「明日」の0時（次の切り替わり時間）
    let nextJstMidnightUtcMs = todayJstMidnightUtcMs + MS_PER_DAY;

    // もし現在時刻が既に0:00を過ぎている場合、次の次の0:00まで待つ
    if (nextJstMidnightUtcMs <= currentUtcMs) {
        nextJstMidnightUtcMs += MS_PER_DAY;
    }
    
    // 次の実行までのミリ秒
    const msToWait = nextJstMidnightUtcMs - currentUtcMs;

    // 2. スケジュール実行
    console.log(`次のフロントライン情報更新まで ${(msToWait / 3600000).toFixed(2)} 時間待機します...`);

    setTimeout(async () => {
        await dailyAnnouncementTask();
        // 実行後、次の日のために再スケジュール (24時間後)
        startDailyScheduler(); 
    }, msToWait);
}

/**
 * 毎日0:00 JSTに実行されるタスク: アナウンスの送信と前日メッセージの削除
 */
async function dailyAnnouncementTask() {
    console.log('--- 0:00 JST 定期アナウンス実行 ---');
    
    // 1. メタデータを取得
    const metaDoc = await getDoc(metaDocRef);
    if (!metaDoc.exists() || !metaDoc.data().targetChannelId) {
        console.error('アナウンスのターゲットチャンネルが設定されていません。/todayを最初に実行して設定してください。');
        return;
    }
    
    const metaData = metaDoc.data();
    const targetChannelId = metaData.targetChannelId;
    const lastMessageId = metaData.lastAnnouncementMessageId;

    const currentMap = getCurrentFrontlineMap();
    const rotationNames = FRONTLINE_ROTATION.map(m => m.short).join(' → ');

    const currentMapIndex = FRONTLINE_ROTATION.findIndex(m => m.name === currentMap.name);
    const nextMapIndex = (currentMapIndex + 1) % FRONTLINE_ROTATION.length;
    const nextMap = FRONTLINE_ROTATION[nextMapIndex];
    
    // 2. 新しいアナウンスメッセージを作成
    const newAnnouncementContent = 
        `📢 **【フロントライン 今日のマップ】**\n` +
        `**日付:** ${new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' })}\n\n` +
        `今日開催されるマップはこちらです。\n\n` +
        `>>> **${currentMap.name}**\n\n` +
        `**ローテーション順序:** ${rotationNames}\n` +
        `*（次は ${nextMap.name} に切り替わります）*`;

    try {
        const channel = await client.channels.fetch(targetChannelId);
        if (channel && channel.isTextBased()) {
            
            // 3. 前日のメッセージを削除
            if (lastMessageId) {
                try {
                    // IDを使用してメッセージを削除（存在しない場合はcatchされる）
                    const messageChannel = await client.channels.fetch(targetChannelId);
                    if (messageChannel) {
                        const oldMessage = await messageChannel.messages.fetch(lastMessageId).catch(() => null);
                        if (oldMessage) {
                            await oldMessage.delete();
                            console.log(`前日のアナウンスを削除しました: ${lastMessageId}`);
                        }
                    }
                } catch (deleteError) {
                    console.warn(`前日のメッセージ (${lastMessageId}) の削除に失敗しましたが、続行します:`, deleteError.message);
                }
            }
            
            // 4. 新しいメッセージを送信
            const newMessage = await channel.send({ content: newAnnouncementContent });
            
            // 5. Firestoreを更新 (新しいメッセージIDを保存)
            await setDoc(metaDocRef, { 
                targetChannelId: targetChannelId, 
                lastAnnouncementMessageId: newMessage.id,
                updatedAt: serverTimestamp()
            }, { merge: true });

            console.log(`新しいアナウンスを送信しました: ${newMessage.id}`);

        } else {
            console.error(`ターゲットチャンネルID (${targetChannelId}) が無効か、テキストチャンネルではありません。`);
        }
    } catch (error) {
        console.error("日次アナウンスの実行中にエラーが発生しました:", error);
    }
}


/**
 * 文字列の最初の文字を大文字にし、残りを小文字に変換します。
 * FFXIVのキャラクター名形式に合わせるためのヘルパー関数。
 * @param {string} str 変換する文字列
 * @returns {string} 変換後の文字列
 */
function capitalize(str) {
    if (!str || typeof str !== 'string') return '';
    const trimmed = str.trim();
    if (trimmed.length === 0) return '';
    
    // 最初の文字を大文字にし、残りの文字を小文字にする（日本語を含む文字列にも適用）
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

/**
 * 優勝チームのスコアに基づいて、フィールド名を決定する
 * @param {number} winningScore - 1位チームのポイント
 * @returns {string} フィールド名
 */
function determineFieldByScore(winningScore) {
    if (winningScore >= 2400) {
        return '外縁遺跡群　制圧戦';
    } else if (winningScore >= 2000) {
        return 'フィールド・オブ・グローリー　砕氷戦';
    } else if (winningScore >= 1400) {
        return 'オンサル・ハカイル　終節戦';
    } else if (winningScore >= 700) {
        return 'シールロック　争奪戦';
    } else {
        return 'フィールド不明 (ポイント不足/時間切れ)';
    }
}

// --- Discordコマンド定義 ---
const commands = [
    {
        name: 'link',
        description: 'LodestoneキャラクターとDiscordユーザーを紐づけます。',
        options: [
            {
                name: 'lodestone_id',
                description: 'キャラクターページのURLにあるLodestone ID (数字のみ)',
                type: ApplicationCommandOptionType.String,
                required: true,
            },
        ],
    },
    {
        name: 'unlink',
        description: '現在のLodestoneキャラクターとの紐づけを解除します。',
    },
    {
        name: 'status',
        description: '現在のLodestoneとの紐づけ状態を確認します。',
    },
    {
        name: 'record',
        description: 'フロントラインのリザルトを手動で記録します。',
        options: [
            { name: 'rank', description: 'マッチの結果順位（1, 2, 3）', type: ApplicationCommandOptionType.Integer, required: true, choices: [{ name: '1位', value: 1 }, { name: '2位', value: 2 }, { name: '3位', value: 3 }] },
            { name: 'job', description: 'プレイしたジョブ', type: ApplicationCommandOptionType.String, required: true, choices: JOB_CHOICES },
            { name: 'kills', description: 'キル数 (Kills)', type: ApplicationCommandOptionType.Integer, required: true, minValue: 0 },
            { name: 'deaths', description: 'デス数 (Deaths)', type: ApplicationCommandOptionType.Integer, required: true, minValue: 0 },
            { name: 'assists', description: 'アシスト数 (Assists)', type: ApplicationCommandOptionType.Integer, required: true, minValue: 0 },
            { name: 'damage_dealt', description: '対人与ダメージ (Damage Dealt to other players)', type: ApplicationCommandOptionType.Integer, required: true, minValue: 0 },
            { name: 'damage_taken', description: '被ダメージ (Damage Taken)', type: ApplicationCommandOptionType.Integer, required: true, minValue: 0 },
            { name: 'healing_done', description: '与ヒール (Healing Done)', type: ApplicationCommandOptionType.Integer, required: true, minValue: 0 },
        ],
    },
    {
        name: 'deleterecord',
        description: '指定したIDのフロントラインリザルトを削除します。',
        options: [
            { name: 'record_id', description: '削除したいリザルトのID', type: ApplicationCommandOptionType.String, required: true },
        ],
    },
    // --- /today コマンドの定義 ---
    {
        name: 'today',
        description: '今日のフロントラインのマップを確認し、自動アナウンスチャンネルを設定します。'
    },
    // ★修正: あやしいプレイヤーを登録するコマンド (名/姓に分割)
    {
        name: 'watchlist_add',
        description: 'あやしいプレイヤーをリストに登録し、コマンドメッセージを削除します。',
        options: [
            { 
                name: 'first_name', 
                description: 'キャラクターの「名」 (例: Tanaka)', 
                type: ApplicationCommandOptionType.String, 
                required: true 
            },
            { 
                name: 'last_name', 
                description: 'キャラクターの「姓」 (例: Tarou)', 
                type: ApplicationCommandOptionType.String, 
                required: true 
            },
            { name: 'world_name', description: 'ワールド名（サーバー名）', type: ApplicationCommandOptionType.String, required: true },
            { name: 'memo', description: 'あやしい行動や理由のメモ', type: ApplicationCommandOptionType.String, required: true },
        ],
    },
    // ★追加: ウォッチリストから名前を指定して削除するコマンド
    {
        name: 'watchlist_delete',
        description: '指定した名前のプレイヤーをウォッチリストから削除します。',
        options: [
            { 
                name: 'first_name', 
                description: 'キャラクターの「名」 (例: Tanaka)', 
                type: ApplicationCommandOptionType.String, 
                required: true 
            },
            { 
                name: 'last_name', 
                description: 'キャラクターの「姓」 (例: Tarou)', 
                type: ApplicationCommandOptionType.String, 
                required: true 
            },
            { 
                name: 'world_name', 
                description: 'ワールド名（サーバー名）。指定すると削除対象を絞り込めます。', 
                type: ApplicationCommandOptionType.String, 
                required: false 
            },
        ],
    },
    // ★新規追加: ウォッチリストをチェックするコマンド
    {
        name: 'watchlist_check',
        description: 'プレイヤー名がウォッチリストに登録されているか確認します。',
        options: [
            { 
                name: 'first_name', 
                description: 'チェックしたいキャラクターの「名」 (例: Tanaka)', 
                type: ApplicationCommandOptionType.String, 
                required: true 
            },
            { 
                name: 'last_name', 
                description: 'チェックしたいキャラクターの「姓」 (例: Tarou)', 
                type: ApplicationCommandOptionType.String, 
                required: true 
            },
            { 
                name: 'world_name', 
                description: 'ワールド名（サーバー名）。指定するとより正確に検索します。', 
                type: ApplicationCommandOptionType.String, 
                required: false 
            },
        ],
    },
   // ★★★ 軍師報告コマンド (/strategist_report) ★★★
    // {
    //     name: 'strategist_report',
    //     description: '軍師の試合結果を記録します。',
    //     options: [
    //         {
    //             name: 'rank',
    //             description: 'チームの最終順位 (1, 2, 3)',
    //             type: ApplicationCommandOptionType.Integer, // 整数型
    //             required: true,
    //             choices: [ // 選択肢として表示されます
    //                 { name: '1位 (勝利)', value: 1 },
    //                 { name: '2位', value: 2 },
    //                 { name: '3位', value: 3 },
    //             ],
    //         },
    //         {
    //             name: 'first_name',
    //             description: '軍師の名前（名、例: Tarou）',
    //             type: ApplicationCommandOptionType.String, // 文字列型
    //             required: true,
    //         },
    //         {
    //             name: 'last_name',
    //             description: '軍師の苗字（例: Yamada）',
    //             type: ApplicationCommandOptionType.String, // 文字列型
    //             required: true,
    //         },
    //     ],
    // },
{
    name: 'strategist_search',
    description: '特定の軍師の過去の戦績を検索し、勝率を表示します。',
    options: [
        {
            name: 'first_name', // 苗字
            description: '検索したい軍師の苗字（例: Yamada）',
            type: ApplicationCommandOptionType.String,
            required: true,
        },
        {
            name: 'last_name', // 名前（名）
            description: '検索したい軍師の名前（名、例: Tarou）',
            type: ApplicationCommandOptionType.String,
            required: true,
        },
    ],
},
{
    name: 'act_record',
    description: 'ACTのPvPサマリーCSVと試合順位を記録します。',
    options: [
        {
            name: 'my_team',
            description: '自分の所属アライアンス（黒渦団、双蛇党、不滅隊）',
            type: ApplicationCommandOptionType.String,
            required: true,
            choices: [
                { name: '黒渦団', value: 'Maelstrom' },
                { name: '双蛇党', value: 'Twin Adders' },
                { name: '不滅隊', value: 'Immortal Flames' },
            ],
        },
        {
            name: 'maelstrom_points',
            description: '黒渦団の最終ポイント',
            type: ApplicationCommandOptionType.Integer,
            required: true,
        },
        {
            name: 'twin_adders_points',
            description: '双蛇党の最終ポイント',
            type: ApplicationCommandOptionType.Integer,
            required: true,
        },
        {
            name: 'immortal_flames_points',
            description: '不滅隊の最終ポイント',
            type: ApplicationCommandOptionType.Integer,
            required: true,
        },
        {
            name: 'my_kills',
            description: 'あなたのキル数 (ACTデータ内のKillsではなく、手入力)',
            type: ApplicationCommandOptionType.Integer,
            required: true,
        },
        {
            name: 'my_assists',
            description: 'あなたのアシスト数',
            type: ApplicationCommandOptionType.Integer,
            required: true,
        },
        {
            name: 'strategist_first',
            description: '軍師の「姓」を入力してください。（例：Taro）',
            type: ApplicationCommandOptionType.String,
            required: false,
        },
        {
            name: 'strategist_last',
            description: '軍師の「名」を入力してください。（例：Yamada）',
            type: ApplicationCommandOptionType.String,
            required: false,
        },
    ],
},
];

async function getLodestoneCharacterInfo(lodestoneId) {
    // LodestoneのHTML構造の変更に耐えるため、cheerioの利用を推奨します。
    // Node.js環境を想定し、ここでは便宜的にrequireしますが、本来はファイル冒頭でインポートすべきです。
    // もしcheerioをインストールしていない場合は、npm install cheerio を実行してください。
    const cheerio = require('cheerio'); 
    
    const url = `https://jp.finalfantasyxiv.com/lodestone/character/${lodestoneId}/`;
    
    try {
        // Lodestoneへのアクセス (User-AgentとTimeoutは維持)
        const response = await axios.get(url, {
            headers: {
                // スクレイピング対策としてUser-Agentを設定
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 10000 // タイムアウトを10秒に設定
        });
        
        const html = response.data;
        const $ = cheerio.load(html); // CheerioでHTMLをパース

        let charName = null;
        let combinedServerString = null;
        
        // 1. キャラクター名の抽出
        // セレクタ: .frame__chara__name (キャラクター名が表示されている要素)
        const nameElement = $('.frame__chara__name');
        if (nameElement.length) {
            charName = nameElement.text().trim();
        }

        // 2. ワールド/DC名の抽出
        // セレクタ: .frame__chara__world (ワールド名とDC名が表示されている要素)
        const serverElement = $('.frame__chara__world');
        if (serverElement.length) {
             // テキストコンテンツを取得し、改行や余分なスペースを削除して整形
             // 例: "Ifrit [Gaia]" のような文字列を取得
            combinedServerString = serverElement.text().trim().replace(/[\n\r\t]/g, ' ').replace(/\s{2,}/g, ' ').trim();
        }
        
        // 3. データのパース (例: "Ifrit [Gaia]" -> world="Ifrit", dataCenter="Gaia")
        let world = null;
        let dataCenter = null;

        if (combinedServerString) {
            // 現在の Lodestone の標準形式 `ワールド名 [DC名]` を正規表現で抽出
            const dcRegex = /(.*?) \[(\w+)\]/;
            const dcMatch = combinedServerString.match(dcRegex);

            if (dcMatch && dcMatch.length === 3) {
                world = dcMatch[1].trim();      
                dataCenter = dcMatch[2].trim(); 
            } else {
                // 形式が一致しなかった場合、全体をワールド名とし、DCは「不明」とする
                world = combinedServerString;
                dataCenter = '不明'; 
                console.warn(`Lodestone ID ${lodestoneId}: DC情報の抽出に失敗。全体をワールド名として処理: ${combinedServerString}`);
            }
        }
        
        // 4. 結果の返却
        // 名前とワールドが取得できていれば成功
        if (charName && world) { 
            return { success: true, charName: charName, world: world, dataCenter: dataCenter };
        } else {
            // 情報が抽出できなかった場合
            console.error(`Lodestone ID ${lodestoneId}: 抽出エラー - charName: ${charName}, combinedServerString: ${combinedServerString}`);
            return { success: false, reason: "Lodestoneページからのキャラクター名とワールド/DCの抽出に失敗しました。Lodestone IDが正しいか、またはキャラクターが存在するか確認してください。" };
        }

    } catch (error) {
        // HTTPエラーハンドリングは元のコードを維持
        if (error.response) {
            const status = error.response.status;
            if (status === 404) {
                 return { success: false, reason: "Lodestone IDに対応するキャラクターページが見つかりませんでした (404 Not Found)。" };
            } else if (status === 403) {
                 return { success: false, reason: "Lodestoneからのデータ取得がブロックされました (403 Forbidden)。時間を置いて再試行してください。" };
            } else {
                 return { success: false, reason: `Lodestoneアクセスエラー (HTTP ${status})。IDが正しいか確認してください。` };
            }
        }
        // ネットワークやその他の予期せぬエラー
        console.error(`Lodestone ID ${lodestoneId}: アクセス中に予期せぬエラー発生`, error.message);
        return { success: false, reason: "Lodestoneへのアクセス中に予期せぬエラーが発生しました（ネットワークエラーなど）。" };
    }
}
// ... (getLodestoneCharacterInfo 関数は変更なし) ...


// ボットがDiscordに接続して準備が完了したときのイベント
client.on('ready', async () => {
    console.log(`ボットが起動しました！ログインユーザー: ${client.user.tag}`);
    client.user.setActivity('フロントラインの記録を分析中');

    // --- スラッシュコマンドの登録処理 (グローバル登録) ---
    const rest = new REST({ version: '10' }).setToken(token);
    
    try {
        console.log('スラッシュコマンドのグローバル登録を開始します。（反映に時間がかかる場合があります）');
        
        await rest.put(
            Routes.applicationCommands(clientId),
            { body: commands },
        );
        
        console.log('スラッシュコマンドの登録に成功しました。');
    } catch (error) {
        console.error('スラッシュコマンドの登録中にエラーが発生しました:', error);
    }
    
    // 🔥 日次スケジューラを起動 だが、BOT再起動時に上手くいかないため一旦コメントアウト
    // startDailyScheduler();
});

// スラッシュコマンドが使用されたときのイベント
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    const { commandName } = interaction;
    const userId = interaction.user.id;
    const userDocRef = doc(db, LINK_COLLECTION_NAME, userId);
    
    // --- /link の処理 (埋め込みとアイコン画像を追加) --- 
    if (commandName === 'link') {
        await interaction.deferReply({ ephemeral: false });

        const lodestoneId = interaction.options.getString('lodestone_id');
        const discordUser = interaction.user;
        
        if (!/^\d+$/.test(lodestoneId)) {
            // エラー時も埋め込みで返信
            const errorEmbed = new EmbedBuilder()
                .setColor(FF14_COLOR_RED)
                .setTitle('❌ 紐づけ失敗')
                .setDescription('Lodestone IDは数字のみで構成されている必要があります。確認してください。')
                .setTimestamp();

            return interaction.editReply({ embeds: [errorEmbed] });
        }
        
        try {
            // getLodestoneCharacterInfoがiconUrlを返すように修正されていることが前提
            const infoResult = await getLodestoneCharacterInfo(lodestoneId);

            if (infoResult.success) {
                const linkData = {
                    lodestoneId: lodestoneId,
                    charName: infoResult.charName,
                    world: infoResult.world,
                    dataCenter: infoResult.dataCenter,
                    linkedAt: new Date().toISOString(),
                    discordTag: discordUser.tag 
                };
                
                await setDoc(userDocRef, linkData);
                
                let roleMessage = '';
                let channelMention = '';
                
                // ロール付与とチャンネル作成が可能な環境かチェック
                if (interaction.member && interaction.guild) {
                    const guild = interaction.guild;
                    const charName = infoResult.charName;
                    
                    // 1. キャラクター名ロールのオブジェクトを取得/作成 (チャンネル権限設定に必要)
                    const characterRole = await findOrCreateRole(guild, charName, FF14_COLOR_GOLD);

                    // 2. ロールをメンバーに付与 (ff14ロールも含む)
                    const assignedRoles = await assignCharacterRoles(interaction.member, charName);
                    
                    if (assignedRoles && assignedRoles.length > 0) {
                        roleMessage = `キャラクター名ロールと「ff14」ロール（**${assignedRoles.join(', ')}**）を付与しました。`;
                    } else if (assignedRoles === null) {
                        roleMessage = `⚠️ ロール付与に失敗しました。Botのロールがサーバー内で最上位付近にあるか確認してください。`;
                    } else if (assignedRoles && assignedRoles.length === 0) {
                        roleMessage = `ロール更新は不要でした。`;
                    }

                    // 3. プライベートチャンネルを作成/確認 (characterRoleが取得できた場合のみ)
                    if (characterRole) {
                            const privateChannel = await findOrCreatePrivateCharacterChannel(
                                guild, 
                                charName, 
                                characterRole, 
                                discordUser
                            );
                            
                            if (privateChannel) {
                                channelMention = privateChannel.toString();
                            } else {
                                roleMessage += `\n⚠️ 専用チャンネルの作成/権限設定に失敗しました。`;
                            }
                    }

                } else {
                     roleMessage = `⚠️ サーバー外での実行のため、ロール・チャンネルの処理はスキップされました。`;
                }
                
                // 埋め込みメッセージの構築
                const successEmbed = new EmbedBuilder()
                    .setColor(FF14_COLOR_GOLD) // FF14っぽい色
                    .setTitle('✅ Lodestone 紐づけ完了')
                    .setDescription(`Discordユーザー **${discordUser.tag}** のFF14キャラクター情報が登録されました。`)
                    .setURL(`https://jp.finalfantasyxiv.com/lodestone/character/${lodestoneId}/`)
                    .setThumbnail(infoResult.iconUrl) // ★Lodestoneから取得したアイコン画像を設定しようと思ったけど失敗してる　でも動作には問題ないから放置
                    .addFields(
                        { name: 'キャラクター名', value: infoResult.charName, inline: true },
                        { name: 'ワールド/DC', value: `${infoResult.world} (${infoResult.dataCenter})`, inline: true },
                        { name: 'Lodestone ID', value: lodestoneId, inline: true },
                        { name: 'ロール付与ステータス', value: roleMessage, inline: false },
                    )
                    .setFooter({ text: 'リザルトを記録するには、/record コマンドを、actを用いた記録には/act_recordを使用してください。' })
                    .setTimestamp();

                if (channelMention) {
                    successEmbed.addFields(
                         { name: '専用チャンネル', value: `✅ ${channelMention} を作成/確認しました。`, inline: false }
                    );
                }


                return interaction.editReply({
                    embeds: [successEmbed]
                });

            } else {
                // 失敗時の埋め込み
                const errorEmbed = new EmbedBuilder()
                    .setColor(FF14_COLOR_RED)
                    .setTitle('❌ Lodestone 紐づけ失敗')
                    .setDescription(`Lodestone ID \`${lodestoneId}\` の情報取得に失敗しました。`)
                    .addFields(
                         { name: '理由', value: infoResult.reason, inline: false }
                    )
                    .setTimestamp();
                    
                return interaction.editReply({
                    embeds: [errorEmbed]
                });
            }
        } catch (error) {
            console.error("致命的なエラーが発生しました (/linkコマンド):", error);
            
            // 致命的なエラー時の埋め込み
            const fatalErrorEmbed = new EmbedBuilder()
                .setColor(FF14_COLOR_RED)
                .setTitle('🚨 致命的なエラー')
                .setDescription('Lodestone IDの紐づけ処理中に予期せぬエラーが発生しました。')
                .addFields(
                    { name: 'エラー詳細', value: `\`${error.message}\``, inline: false }
                )
                .setTimestamp();

            return interaction.editReply({ embeds: [fatalErrorEmbed] });
        }
    }

    // --- /unlink, /status, /record, /deleterecord, /today, /watchlist... の処理は変更なし ---
if (commandName === 'unlink') {
        // Ephemeral（実行者のみ）で応答を待機
        await interaction.deferReply({ ephemeral: true });

        const member = interaction.member;
        
        try {
            const docSnapshot = await getDoc(userDocRef);

            if (docSnapshot.exists()) {
                const { charName } = docSnapshot.data();
                
                // 1. ロール削除処理
                const charRole = member.guild.roles.cache.find(r => r.name === charName);
                const ff14Role = member.guild.roles.cache.find(r => r.name === 'ff14');
                const rolesToRemove = [];
                let removedRoleNames = '';

                // キャラクター名ロールの削除準備
                if (charRole && member.roles.cache.has(charRole.id)) {
                    rolesToRemove.push(charRole.id);
                    removedRoleNames += `\`${charName}\`ロール`;
                }
                // ff14ロールの削除準備
                if (ff14Role && member.roles.cache.has(ff14Role.id)) {
                    rolesToRemove.push(ff14Role.id);
                    if (removedRoleNames) removedRoleNames += '、';
                    removedRoleNames += '`ff14`ロール';
                }

                if (rolesToRemove.length > 0) {
                    await member.roles.remove(rolesToRemove, 'Lodestone紐づけ解除に伴うロール削除');
                }
                
                // 2. Firestoreから紐づけ情報を削除
                await deleteDoc(userDocRef);

                // 3. 成功時の埋め込みメッセージ
                const embed = new EmbedBuilder()
                    .setTitle('✅ Lodestone 紐づけ解除完了')
                    .setDescription(`Discordアカウントと、キャラクター **${charName}** の紐づけを解除しました。`)
                    .setColor(FF14_COLOR_GOLD)
                    .addFields({
                        name: '削除されたロール',
                        value: removedRoleNames || '該当するロールはありませんでした。',
                        inline: false
                    })
                    .setTimestamp();
                
                return interaction.editReply({ embeds: [embed] });

            } else {
                // 4. 未リンク時の埋め込みメッセージ
                const embed = new EmbedBuilder()
                    .setTitle('❌ 紐づけ情報なし')
                    .setDescription('現在、このDiscordアカウントと紐づけされているLodestoneキャラクターはありません。')
                    .setColor(FF14_COLOR_RED);

                return interaction.editReply({ embeds: [embed] });
            }
        } catch (error) {
            console.error("リンク解除処理でエラーが発生しました:", error);
            
            // 5. エラー時の埋め込みメッセージ
            const embed = new EmbedBuilder()
                .setTitle('🚨 処理エラー')
                .setDescription('Lodestoneの紐づけ解除中に致命的なエラーが発生しました。')
                .addFields({
                    name: 'エラー詳細',
                    value: `\`\`\`${error.message}\`\`\``,
                    inline: false
                })
                .setColor(FF14_COLOR_RED)
                .setFooter({ text: 'ボットのログを確認してください。' });

            return interaction.editReply({ embeds: [embed] });
        }
    }

if (commandName === 'status') {
        // Ephemeral: false（全員に見える）で応答を待機
        await interaction.deferReply({ ephemeral: false });
        
        try {
            const docSnapshot = await getDoc(userDocRef);

            if (docSnapshot.exists()) {
                const linkInfo = docSnapshot.data();
                const charName = linkInfo.charName;
                const lodestoneId = linkInfo.lodestoneId;

                // ワールド/DC情報を整形
                const worldInfo = linkInfo.world && linkInfo.dataCenter 
                    ? `${linkInfo.world} (DC: ${linkInfo.dataCenter})` 
                    : linkInfo.world || linkInfo.server || '不明'; 
                
                // 紐づけ日時を整形
                const linkedAt = linkInfo.linkedAt 
                    ? new Date(linkInfo.linkedAt).toLocaleString('ja-JP') 
                    : '不明';

                // LodestoneのプロフィールURL
                const lodestoneUrl = `https://jp.finalfantasyxiv.com/lodestone/character/${lodestoneId}/`;
                
                // 成功時の埋め込みメッセージ
                const embed = new EmbedBuilder()
                    .setTitle(`🛡️ ${charName} さんの現在の紐づけ情報`)
                    .setURL(lodestoneUrl) // タイトルにLodestoneへのリンクを設定
                    .setColor(FF14_COLOR_GOLD)
                    .setThumbnail(linkInfo.iconUrl || 'https://placehold.co/100x100/AA946F/ffffff?text=FF14') // アイコンURLがあれば使用
                    .addFields(
                        { 
                            name: 'キャラクター名', 
                            value: charName, 
                            inline: true 
                        },
                        { 
                            name: 'ワールド / データセンター', 
                            value: worldInfo, 
                            inline: true 
                        },
                        { 
                            name: 'Lodestone ID', 
                            value: `\`${lodestoneId}\``, 
                            inline: true 
                        },
                        { 
                            name: 'Discord User', 
                            value: `<@${interaction.user.id}> (${interaction.user.tag})`, 
                            inline: false 
                        },
                        { 
                            name: '紐づけ日時', 
                            value: linkedAt, 
                            inline: false 
                        }
                    )
                    .setFooter({ text: '情報更新には /link コマンドを再実行してください。' })
                    .setTimestamp();

                return interaction.editReply({ embeds: [embed] });

            } else {
                // 未リンク時の埋め込みメッセージ
                const embed = new EmbedBuilder()
                    .setTitle('❓ 紐づけ情報なし')
                    .setDescription('現在、このDiscordアカウントとLodestoneキャラクターは紐づけされていません。')
                    .setColor(FF14_COLOR_RED)
                    .addFields({
                        name: '紐づけ方法',
                        value: 'スラッシュコマンド `/link` を使用し、あなたのLodestone ID (キャラクターURLの末尾の数字) を入力してください。',
                        inline: false
                    });

                return interaction.editReply({ embeds: [embed] });
            }
        } catch (error) {
            console.error("ステータス確認処理でエラーが発生しました:", error);
            
            // エラー時の埋め込みメッセージ
            const embed = new EmbedBuilder()
                .setTitle('🚨 処理エラー')
                .setDescription('ステータスの確認中に致命的なエラーが発生しました。')
                .addFields({
                    name: 'エラー詳細',
                    value: `\`\`\`${error.message}\`\`\``,
                    inline: false
                })
                .setColor(FF14_COLOR_RED)
                .setFooter({ text: 'ボットのログを確認してください。' });

            return interaction.editReply({ embeds: [embed] });
        }
    }
    
if (commandName === 'record') {
        await interaction.deferReply({ ephemeral: false });

        const userId = interaction.user.id;
        const linkDoc = await getDoc(userDocRef);
        
        // 1. リンク情報がない場合の処理を埋め込み化
        if (!linkDoc.exists() || !linkDoc.data().world || !linkDoc.data().dataCenter) {
            const embed = new EmbedBuilder()
                .setTitle('❌ 記録失敗: Lodestone紐づけエラー')
                .setDescription('リザルトを記録するには、まず `/link` コマンドでLodestoneキャラクターを紐づけしてください。ワールド/DC情報が不足しています。')
                .setColor(FF14_COLOR_RED)
                .setFooter({ text: '情報が古い場合は、再度 /link コマンドを実行してください。' });

            return interaction.editReply({ embeds: [embed] });
        }
        
        const linkInfo = linkDoc.data();
        
        const rank = interaction.options.getInteger('rank');
        const job = interaction.options.getString('job');
        const kills = interaction.options.getInteger('kills');
        const deaths = interaction.options.getInteger('deaths');
        const assists = interaction.options.getInteger('assists');
        const damageDealt = interaction.options.getInteger('damage_dealt');
        const damageTaken = interaction.options.getInteger('damage_taken');
        const healingDone = interaction.options.getInteger('healing_done');

        try {
            const resultColRef = collection(db, RESULT_COLLECTION_NAME);
            
            const recordData = {
                lodestoneId: linkInfo.lodestoneId,
                charName: linkInfo.charName,
                world: linkInfo.world,
                dataCenter: linkInfo.dataCenter,
                discordId: userId,
                discordTag: interaction.user.tag,
                rank: rank,
                job: job,
                kills: kills,
                deaths: deaths,
                assists: assists,
                damageDealt: damageDealt,
                damageTaken: damageTaken,
                healingDone: healingDone,
                recordedAt: serverTimestamp(),
                channelId: interaction.channelId,
                guildId: interaction.guildId,
                messageId: null, // 後で更新される
            };

            const docRef = await addDoc(resultColRef, recordData);
            const recordId = docRef.id;
            
            // ジョブ情報 (JOB_CHOICES, JOB_EMOJISは既存のものを使用)
            const jobChoice = JOB_CHOICES.find(c => c.value === job);
            const jobName = jobChoice ? jobChoice.name : job;
            const jobEmoji = JOB_EMOJIS[job] || '✨'; 

            // 2. 成功時の応答を埋め込み化
            const embed = new EmbedBuilder()
                .setTitle('✅ フロントライン リザルトを記録しました！')
                .setColor(FF14_COLOR_GOLD)
                .addFields(
                    { 
                        name: 'キャラクター', 
                        value: `${linkInfo.charName} (${linkInfo.dataCenter}DC)`, 
                        inline: true 
                    },
                    { 
                        name: '順位', 
                        value: `**${rank}位**`, 
                        inline: true 
                    },
                    { 
                        name: 'ジョブ', 
                        value: `${jobEmoji} ${jobName}`, 
                        inline: true 
                    },
                    { 
                        name: 'K/D/A', 
                        value: `${kills} / ${deaths} / ${assists}`, 
                        inline: true 
                    },
                    { 
                        name: '与ダメージ / 被ダメージ', 
                        value: `${damageDealt.toLocaleString()} / ${damageTaken.toLocaleString()}`, 
                        inline: true 
                    },
                    { 
                        name: '与回復', 
                        value: healingDone.toLocaleString(), 
                        inline: true 
                    }
                )
                .setFooter({ 
                    text: `記録ID: ${recordId} | 削除には /deleterecord を使用`, 
                })
                .setTimestamp(); // 記録時刻はDiscordが自動で付与

            const reply = await interaction.editReply({
                embeds: [embed],
            });

            // メッセージIDを記録に紐づけ
            const messageId = reply.id;
            await updateDoc(docRef, {
                messageId: messageId
            });

            return;
            
        } catch (error) {
            console.error("リザルト記録処理でエラーが発生しました (/recordコマンド):", error);
            
            // 3. 致命的なエラー時の応答を埋め込み化
            const embed = new EmbedBuilder()
                .setTitle('🚨 記録処理エラー')
                .setDescription('リザルトの記録中に予期せぬエラーが発生しました。')
                .addFields({
                    name: 'エラー詳細',
                    value: `\`\`\`${error.message}\`\`\``,
                    inline: false
                })
                .setColor(FF14_COLOR_RED)
                .setFooter({ text: 'ボットのログを確認してください。' });

            return interaction.editReply({ embeds: [embed] });
        }
    }
    
    if (commandName === 'deleterecord') {
        await interaction.deferReply({ ephemeral: true });

        const recordId = interaction.options.getString('record_id');
        const resultDocRef = doc(db, RESULT_COLLECTION_NAME, recordId); 

        let dataToDelete = null;

        try {
            const docSnapshot = await getDoc(resultDocRef);

            if (!docSnapshot.exists()) {
                // 1. 記録見つからず
                const embed = new EmbedBuilder()
                    .setTitle('❌ 削除失敗: 記録が見つかりません')
                    .setDescription(`ID: \`${recordId}\` に対応するリザルト記録が見つかりませんでした。IDをもう一度確認してください。`)
                    .setColor(FF14_COLOR_RED);
                return interaction.editReply({ embeds: [embed] });
            }

            dataToDelete = docSnapshot.data();

            if (dataToDelete.discordId !== userId) {
                // 2. 権限エラー
                const embed = new EmbedBuilder()
                    .setTitle('❌ 権限エラー')
                    .setDescription('この記録はあなたが作成したものではありません。削除できません。')
                    .setColor(FF14_COLOR_RED);
                return interaction.editReply({ embeds: [embed] });
            }
            
            // 記録を削除
            await deleteDoc(resultDocRef);

            let footerText = '記録は削除されました。';

            // 元のDiscordメッセージを削除
            if (dataToDelete.messageId && dataToDelete.channelId) {
                try {
                    const channel = await client.channels.fetch(dataToDelete.channelId);
                    if (channel && channel.messages) {
                        const messageToDelete = await channel.messages.fetch(dataToDelete.messageId).catch(() => null);
                        if (messageToDelete) {
                            await messageToDelete.delete();
                            footerText = '元のDiscordメッセージも削除しました。';
                        } else {
                            footerText = '記録は削除されましたが、元のDiscordメッセージは見つかりませんでした。';
                        }
                    }
                } catch (msgDeleteError) {
                    console.error(`メッセージID ${dataToDelete.messageId} の削除中にエラーが発生しましたが、記録は削除されました:`, msgDeleteError);
                    footerText = 'メッセージ削除中にエラーが発生しましたが、記録は削除されました。';
                }
            }

            // 3. 成功
            const jobCode = dataToDelete.job;
            const jobName = JOB_CHOICES.find(c => c.value === jobCode)?.name || jobCode;
            const jobEmoji = JOB_EMOJIS[jobCode] || '✨'; 
            const rank = dataToDelete.rank;
            
            const deleteTime = dataToDelete.recordedAt && dataToDelete.recordedAt.toDate 
                                 ? dataToDelete.recordedAt.toDate().toLocaleString('ja-JP') 
                                 : '不明';
            
            const embed = new EmbedBuilder()
                .setTitle(`✅ リザルト記録を削除しました (${rank}位, ${jobName})`)
                .setColor(FF14_COLOR_GOLD)
                .addFields(
                    { name: '削除ID', value: `\`${recordId}\``, inline: false },
                    { name: 'ジョブ', value: `${jobEmoji} ${jobName}`, inline: true },
                    { name: '順位', value: `**${rank}位**`, inline: true },
                    { name: '記録日時', value: deleteTime, inline: false }
                )
                .setFooter({ text: footerText })
                .setTimestamp();

            return interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error("リザルト削除処理でエラーが発生しました (/deleterecordコマンド):", error);
            // 4. 処理エラー
            const embed = new EmbedBuilder()
                .setTitle('🚨 処理エラー')
                .setDescription('リザルトの削除中に予期せぬエラーが発生しました。')
                .addFields({
                    name: 'エラー詳細',
                    value: `\`\`\`${error.message}\`\`\``,
                    inline: false
                })
                .setColor(FF14_COLOR_RED)
                .setFooter({ text: 'ボットのログを確認してください。' });

            return interaction.editReply({ embeds: [embed] });
        }
    }

// ★★★ 今日のフロントラインマップコマンドの処理 (/today) --- 修正箇所 ★★★
    // else if (interaction.commandName === 'today') {
    //     await interaction.deferReply({ ephemeral: false });

    //     // ★修正済み: 正しい計算ロジックを持つ getCurrentFrontlineMap を使用
    //     const currentMap = getCurrentFrontlineMap();
    //     const rotationNames = FRONTLINE_ROTATION.map(m => m.short).join(' → ');

    //     // 現在のマップインデックスを見つける
    //     const currentMapIndex = FRONTLINE_ROTATION.findIndex(m => m.name === currentMap.name);
        
    //     // 次のマップインデックスを計算
    //     const nextMapIndex = (currentMapIndex + 1) % FRONTLINE_ROTATION.length;
    //     const nextMap = FRONTLINE_ROTATION[nextMapIndex];
        
    //     // メタデータのドキュメント参照を取得
    //     const db = getFirestore(client.firebaseApp);
    //     const metaDocRef = doc(db, META_COLLECTION_NAME, 'announcement');
        
    //     // 埋め込みメッセージの構築に必要な変数
    //     let channelStatusMessage = '✅ このチャンネルは既にアナウンス先に設定されています。';
    //     let errorOccurred = false;
    //     let embedColor = FF14_COLOR_GOLD; // 成功時のデフォルトカラー

    //     // 2. 自動アナウンスチャンネル設定ロジック
    //     try {
    //         const metaDoc = await getDoc(metaDocRef);

    //         if (!metaDoc.exists() || metaDoc.data().targetChannelId !== interaction.channelId) {
    //             // チャンネルIDを保存/更新
    //             await setDoc(metaDocRef, { 
    //                 targetChannelId: interaction.channelId, 
    //                 updatedAt: serverTimestamp()
    //             }, { merge: true });
    //             channelStatusMessage = `📢 **チャンネル設定完了:** このチャンネル（#${interaction.channel.name}）を日次アナウンスの送信先として登録しました。`;
    //         }

    //     } catch (error) {
    //         console.error("自動アナウンスチャンネルの設定中にエラーが発生しました:", error);
    //         channelStatusMessage = '❌ **設定エラー:** 自動アナウンスチャンネルの設定に失敗しました。ボットのログを確認してください。';
    //         errorOccurred = true;
    //         embedColor = FF14_COLOR_RED;
    //     }

    //     // 埋め込みの作成
    //     const embed = new EmbedBuilder()
    //         .setTitle('☀️ 今日のフロントライン情報')
    //         .setColor(embedColor) 
    //         .setDescription('最新のフロントライン情報と、日次アナウンス設定のステータスです。')
    //         .addFields(
    //             { 
    //                 name: '現在開催中のマップ', 
    //                 value: `>>> **${currentMap.name}**`, 
    //                 inline: false 
    //             },
    //             { 
    //                 name: '次回のマップ', 
    //                 value: `${nextMap.name} (明日 0:00 JSTに切り替え)`, 
    //                 inline: true 
    //             },
    //             { 
    //                 name: 'ローテーション順序', 
    //                 value: `${rotationNames} (4日周期)`, 
    //                 inline: true 
    //             },
    //             {
    //                 name: '日次アナウンス設定ステータス',
    //                 value: channelStatusMessage,
    //                 inline: false
    //             }
    //         )
    //         .setTimestamp(); // 現在時刻を反映

    //     await interaction.editReply({ embeds: [embed] });
    // }
    
    // --- /watchlist_add の処理 (登録とメッセージ削除) ---
    if (commandName === 'watchlist_add') {
        // コマンドメッセージと返信メッセージの両方を削除するため、一時的な返信はしない (deferReplyしない)
        
        // ★修正点1: 名と姓を別々に取得
        const firstNameInput = interaction.options.getString('first_name');
        const lastNameInput = interaction.options.getString('last_name');
        const worldName = interaction.options.getString('world_name');
        const memo = interaction.options.getString('memo');

        // FirestoreのuserIdを取得
        const userId = interaction.user.id;

        try {
            // ★修正点2: 頭文字を大文字に変換し、結合して完全なキャラクター名を作成
            const firstName = capitalize(firstNameInput);
            const lastName = capitalize(lastNameInput);
            const characterName = `${firstName} ${lastName}`;
            
            const watchlistColRef = collection(db, WATCHLIST_COLLECTION_NAME);
            
            const watchlistItem = {
                characterName: characterName, // 結合後の名前を保存
                firstName: firstName,         // 名を保存（参考情報として）
                lastName: lastName,           // 姓を保存（参考情報として）
                worldName: worldName,
                memo: memo,
                recordedBy: userId,
                recordedByTag: interaction.user.tag,
                recordedAt: serverTimestamp(),
            };

            // 1. Firestoreに登録
            const docRef = await addDoc(watchlistColRef, watchlistItem);
            const recordId = docRef.id;

            // 埋め込みメッセージを作成
            const embed = new EmbedBuilder()
                .setTitle('✅ ウォッチリストに追加完了！')
                .setColor(FF14_COLOR_GREEN) // ウォッチリストは緑色に設定
                .setDescription(`プレイヤー **${characterName}** (${worldName}) をリストに登録しました。`)
                .addFields(
                    { 
                        name: '登録者', 
                        value: interaction.user.tag, 
                        inline: true 
                    },
                    { 
                        name: '登録ID', 
                        value: `\`${recordId}\``, 
                        inline: true 
                    },
                    { 
                        name: 'メモ', 
                        value: memo || 'なし', 
                        inline: false 
                    }
                )
                .setFooter({
                    text: 'このメッセージとコマンドメッセージは、5秒後に自動で削除されます。'
                })
                .setTimestamp();

            // 2. 返信メッセージを送信
            const reply = await interaction.reply({
                embeds: [embed],
                fetchReply: true,
                ephemeral: false
            });

            // 3. コマンドメッセージと返信メッセージを削除
            setTimeout(async () => {
                try {
                    // コマンドメッセージ（interaction自体）の削除
                    // interaction.deleteReply() は、最初のinteraction.reply()に対する遅延返信/編集しかできないため、
                    // ここではチャンネルから直接メッセージIDを使って削除を試みるのがより確実。
                    // ただし、Discord.jsのInteraction Replyの仕様上、interaction.deleteReply()が
                    // interactionをトリガーとしたメッセージを削除する最も安全な方法。
                    await interaction.deleteReply().catch(err => console.warn(`返信メッセージ削除失敗 (Interaction deleteReply): ${err.message}`));
                    
                    // コマンドメッセージを削除 (interaction.channel.messages.deleteを使用)
                    // interaction.channel.messages.delete(interaction.id) は使用者が実行したメッセージを削除しようとする
                    // interaction.reply()のメッセージがinteraction.deleteReply()で削除されるため、ここでは省略
                    
                } catch (error) {
                    console.error("ウォッチリスト登録後のメッセージ削除中にエラー:", error);
                }
            }, 5000); // 5秒の遅延を設けて確実性を上げる

        } catch (error) {
            console.error("ウォッチリスト登録処理でエラーが発生しました (/watchlist_addコマンド):", error);
            // エラーが発生した場合、メッセージを消さずにエラーを返す（一時的に）
            const embed = new EmbedBuilder()
                .setTitle('🚨 ウォッチリスト登録エラー')
                .setDescription('ウォッチリストの登録中に予期せぬエラーが発生しました。')
                .addFields({
                    name: 'エラー詳細',
                    value: `\`\`\`${error.message}\`\`\``,
                    inline: false
                })
                .setColor(FF14_COLOR_RED);

            await interaction.reply({ 
                embeds: [embed],
                ephemeral: true // エラーメッセージは一時的に表示
            }).catch(() => null);
        }
    }

    
    // --- /watchlist_delete の処理 (名前指定削除) ---
    if (commandName === 'watchlist_delete') {
        await interaction.deferReply({ ephemeral: false });

        const firstNameInput = interaction.options.getString('first_name');
        const lastNameInput = interaction.options.getString('last_name');
        // world_nameはオプション
        const worldNameInput = interaction.options.getString('world_name'); 

        try {
            const firstName = capitalize(firstNameInput);
            const lastName = capitalize(lastNameInput);
            const characterName = `${firstName} ${lastName}`;
            const worldName = worldNameInput ? worldNameInput.trim() : null;
            
            const watchlistColRef = collection(db, WATCHLIST_COLLECTION_NAME);
            
            // 1. 検索クエリの作成
            let q = query(watchlistColRef, where("characterName", "==", characterName));
            
            // world_nameが指定された場合は、さらに条件を追加して絞り込む
            if (worldName) {
                // 複合クエリ: characterName AND worldName
                q = query(watchlistColRef, 
                          where("characterName", "==", characterName),
                          where("worldName", "==", worldName) 
                         );
            }

            // 2. 検索実行
            const querySnapshot = await getDocs(q);
            
            if (querySnapshot.empty) {
                let notFoundMessage = `❌ **削除失敗:** ウォッチリストに**${characterName}**という名前のプレイヤーは見つかりませんでした。`;
                if (worldName) {
                     notFoundMessage += ` (ワールド名: ${worldName} も含む)`;
                }
                return interaction.editReply(notFoundMessage);
            }

            // 3. 見つかったドキュメントをすべて削除
            const deletePromises = [];
            const deletedItems = [];

            querySnapshot.forEach((docSnapshot) => {
                const docRef = doc(db, WATCHLIST_COLLECTION_NAME, docSnapshot.id);
                deletePromises.push(deleteDoc(docRef));
                deletedItems.push(docSnapshot.data());
            });

            await Promise.all(deletePromises);
            
            const deletedCount = deletedItems.length;

            // 4. 成功メッセージの作成
            const deletedList = deletedItems.map(item => 
                `・**${item.characterName}** (${item.worldName}) - メモ: ${item.memo}`
            ).join('\n');

            let successMessage = `✅ **削除成功:** ウォッチリストから以下の${deletedCount}件のプレイヤーを削除しました。\n\n`;
            successMessage += deletedList;
            
            if (worldName && deletedCount > 0) {
                 successMessage += `\n\n*（ワールド名 ${worldName} の条件で絞り込みました）*`;
            } 


            // 5. 最新のリストメッセージを削除
            const metaDoc = await getDoc(watchlistMetaDocRef);
            const lastMessageId = metaDoc.exists() ? metaDoc.data().lastWatchlistMessageId : null;
            
            if (lastMessageId && metaDoc.data().targetChannelId === interaction.channelId) {
                try {
                    const messageChannel = await client.channels.fetch(interaction.channelId);
                    if (messageChannel) {
                        const oldMessage = await messageChannel.messages.fetch(lastMessageId).catch(() => null);
                        if (oldMessage) {
                            await oldMessage.delete();
                        }
                    }
                } catch (deleteError) {
                    console.warn(`リストメッセージ (${lastMessageId}) の削除に失敗しましたが、続行します:`, deleteError.message);
                }
            }


            // 6. 削除結果を応答
            return interaction.editReply(successMessage + '\n\n*最新のウォッチリストを見るには `/watchlist_show` を実行してください。*');

        } catch (error) {
            console.error("ウォッチリスト削除処理でエラーが発生しました (/watchlist_deleteコマンド):", error);
            // Firestoreのエラーメッセージにはインデックスに関する情報が含まれる可能性があるため、そのまま表示しない
            return interaction.editReply(`❌ ウォッチリストの削除中にエラーが発生しました: ${error.message}。Firestoreの複合インデックスが必要な場合があります。`);
        }
    }

// --- ★新規追加: /watchlist_check の処理 ---
    if (commandName === 'watchlist_check') {
        await interaction.deferReply({ ephemeral: false });

        const firstNameInput = interaction.options.getString('first_name');
        const lastNameInput = interaction.options.getString('last_name');
        const worldNameInput = interaction.options.getString('world_name'); 

        try {
            // capitalize関数は他の場所で定義されていることを前提とする
            const firstName = capitalize(firstNameInput);
            const lastName = capitalize(lastNameInput);
            const characterName = `${firstName} ${lastName}`;
            const worldName = worldNameInput ? worldNameInput.trim() : null;
            
            // db, WATCHLIST_COLLECTION_NAMEは他の場所で定義されていることを前提とする
            const watchlistColRef = collection(db, WATCHLIST_COLLECTION_NAME);
            
            // 1. 検索クエリの作成: キャラクター名で検索
            let q = query(watchlistColRef, where("characterName", "==", characterName));
            
            // world_nameが指定された場合は、さらに条件を追加して絞り込む
            if (worldName) {
                // 複合クエリ: characterName AND worldName
                q = query(watchlistColRef, 
                          where("characterName", "==", characterName),
                          where("worldName", "==", worldName) 
                         );
            }

            // 2. 検索実行
            const querySnapshot = await getDocs(q);
            
            if (querySnapshot.empty) {
                // 見つからなかった場合の埋め込み
                const notFoundEmbed = new EmbedBuilder()
                    .setTitle('✅ ウォッチリスト・チェック')
                    .setDescription(`**クリーン！** プレイヤー **${characterName}** はウォッチリストに登録されていません。`)
                    .addFields({
                        name: '検索条件',
                        value: `プレイヤー名: **${characterName}**\nワールド: ${worldName || 'なし (全ワールド対象)'}`,
                        inline: false
                    })
                    .setColor(FF14_COLOR_GREEN) // クリーンは緑色
                    .setTimestamp();
                
                return interaction.editReply({ embeds: [notFoundEmbed] });
            }

            // 3. 見つかった情報をEmbedのフィールドとして整形
            const fields = querySnapshot.docs.map((doc, index) => {
                const data = doc.data();
                const recordTime = data.recordedAt && data.recordedAt.toDate 
                                        ? data.recordedAt.toDate().toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) 
                                        : '不明';
                
                return {
                    name: `🚨 登録 #${index + 1}: ${data.worldName ? `(${data.worldName})` : ''}`,
                    value: `**メモ:** ${data.memo || 'なし'}\n` +
                           `**登録者:** \`${data.recordedByTag}\`\n` +
                           `**登録日時:** ${recordTime} (ID: \`${doc.id}\`)`,
                    inline: false
                };
            });

            // 警戒メッセージの埋め込みを作成
            const alertEmbed = new EmbedBuilder()
                .setTitle(`🚨 ウォッチリストに登録されています！ (${querySnapshot.size}件)`)
                .setDescription(`プレイヤー名: **${characterName}** ${worldName ? ` (ワールド: **${worldName}**)` : ''}`)
                .setColor(FF14_COLOR_RED) // 警戒は赤色
                .addFields(fields)
                .setFooter({
                    text: worldName 
                        ? `ワールド ${worldName} の条件で検索しました。`
                        : `ワールド条件なしで検索しました。`
                })
                .setTimestamp();

            // 4. 応答
            return interaction.editReply({ embeds: [alertEmbed] });

        } catch (error) {
            console.error("ウォッチリストチェック処理でエラーが発生しました (/watchlist_checkコマンド):", error);
            
            // エラーメッセージの埋め込み
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ ウォッチリスト・チェック・エラー')
                .setDescription(`チェック中にエラーが発生しました。\n\`${error.message}\``)
                .setFooter({ text: 'Firestoreの複合インデックスが必要な場合があります。' })
                .setColor(FF14_COLOR_RED)
                .setTimestamp();

            return interaction.editReply({ embeds: [errorEmbed] });
        }
    }
// ★★★ 軍師報告コマンドの処理 (/strategist_report) --- 埋め込み対応 ★★★
    if (interaction.commandName === 'strategist_report') { // 既存のifをelse ifに変更
        // 処理が終わるまで待機し、全員に見えるように返信を準備
        await interaction.deferReply({ ephemeral: false }); 

        const rank = interaction.options.getInteger('rank');
        
        // getString() に戻し、?? '' で null を確実に回避
        const first_name_raw = interaction.options.getString('first_name') ?? '';
        const last_name_raw = interaction.options.getString('last_name') ?? '';

        // null/undefinedを空文字列に変換し、前後の空白を削除
        const safe_first = first_name_raw.trim();
        const safe_last = last_name_raw.trim();

        // インラインで頭文字のみ大文字に変換 (capitalize関数が他で定義されている場合はそれを使うべきだが、ここではインラインのロジックを保持)
        // (三項演算子で安全チェック: 文字列が存在すれば処理、なければ空文字列)
        // ※ 外部のcapitalize関数を使用する場合: const first_name = capitalize(safe_first);
        const first_name = safe_first ? safe_first.charAt(0).toUpperCase() + safe_first.slice(1).toLowerCase() : '';
        const last_name = safe_last ? safe_last.charAt(0).toUpperCase() + safe_last.slice(1).toLowerCase() : '';

        // 入力値のチェック (正規化後の文字列が空でないかを確認)
        if (!first_name || !last_name) {
            // エラーメッセージを埋め込みで返す
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 軍師報告エラー')
                .setDescription('`first_name` (名前) と `last_name` (苗字) は必須入力です。')
                .setColor(FF14_COLOR_RED);

            await interaction.editReply({ embeds: [errorEmbed] });
            return;
        }
        
        // データベースに保存するフルネームも頭文字大文字の形式で作成
        const full_name = `${first_name} ${last_name}`; 
        
        // getFirestore(client.firebaseApp) の代わりに、グローバルに定義されている db を使用
        // ※ 既に `db` は`getFirestore(app)`で初期化されている前提
        // const db = getFirestore(client.firebaseApp); // この行はコメントアウト

        try {
            // データベースに新しいドキュメントを追加 (addDocを使用)
            // STRATEGIST_REPORT_COLLECTION_NAMEは他の場所で定義されていることを前提とする
            await addDoc(collection(db, STRATEGIST_REPORT_COLLECTION_NAME), {
                reported_by_user_id: interaction.user.id,
                reported_by_username: interaction.user.tag, 
                strategist_name: first_name, 
                strategist_surname: last_name, 
                strategist_full_name: full_name, // 頭文字大文字のフルネームを保存
                rank: rank,
                is_win: rank === 1,
                timestamp: serverTimestamp(), // serverTimestampは他の場所で定義されていることを前提とする
                channel_id: interaction.channelId,
                guild_id: interaction.guildId,
            });

            const winStatus = rank === 1 ? '🎉 1位 (勝利)' : `${rank}位`;
            const color = rank === 1 ? FF14_COLOR_BLUE : FF14_COLOR_YELLOW; // 1位は青、それ以外は黄色（または適当な色）

            // 成功メッセージを埋め込みで返す
            const successEmbed = new EmbedBuilder()
                .setTitle('✅ 軍師報告が記録されました！')
                .setDescription(`報告者: ${interaction.user.tag}`)
                .addFields(
                    { name: '軍師名', value: `**${full_name}**`, inline: true },
                    { name: '順位', value: `**${winStatus}**`, inline: true },
                )
                .setColor(color)
                .setTimestamp();

            await interaction.editReply({ embeds: [successEmbed] });

        } catch (error) {
            console.error('軍師報告の保存中にエラーが発生しました:', error);
            
            // エラーメッセージを埋め込みで返す
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 軍師報告エラー')
                .setDescription(`軍師報告の記録中にエラーが発生しました。\nエラー詳細: \`${error.message}\``)
                .setColor(FF14_COLOR_RED)
                .setTimestamp();
            
            await interaction.editReply({ embeds: [errorEmbed] });
        }
        return;
    }
    
    else if (interaction.commandName === 'strategist_search') { // 既存のifをelse ifに変更
        // 処理が終わるまで待機し、全員に見えるように返信を準備
        await interaction.deferReply({ ephemeral: false });

        // ★修正点 1: getString() に戻し、?? '' で null を確実に回避
        const search_last_name_raw = interaction.options.getString('last_name') ?? '';
        const search_first_name_raw = interaction.options.getString('first_name') ?? '';

        // null/undefinedを空文字列に変換し、前後の空白を削除
        const safe_search_first = search_first_name_raw.trim();
        const safe_search_last = search_last_name_raw.trim();

        // インラインで頭文字のみ大文字に変換
        const search_first_name = safe_search_first ? safe_search_first.charAt(0).toUpperCase() + safe_search_first.slice(1).toLowerCase() : '';
        const search_last_name = safe_search_last ? safe_search_last.charAt(0).toUpperCase() + safe_search_last.slice(1).toLowerCase() : '';


        // 入力値のチェック (正規化後の文字列が空でないかを確認)
        // ※ FF14_COLOR_RED の定義がされている前提です
        if (!search_first_name || !search_last_name) {
            // エラーメッセージを埋め込みで返す
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ 軍師検索エラー')
                .setDescription('`first_name` (名前) と `last_name` (苗字) は必須入力です。')
                .setColor(FF14_COLOR_RED);

            await interaction.editReply({ embeds: [errorEmbed] });
            return;
        }
        
        // 検索キーも頭文字大文字の形式で作成: [名前] [苗字]
        const search_full_name = `${search_first_name} ${search_last_name}`; 
        
        try {
            // ★★★ 修正箇所: 検索処理を strategistSearchCommand に委譲 ★★★
            // ※ STRATEGIST_REPORT_COLLECTION_NAME と RESULT_COLLECTION_NAME の両方を検索するロジックに後で変更するかもしれません。
            //    ここでは、ACTデータが保存されている RESULT_COLLECTION_NAME のレコードから、
            //    軍師フラグ (`isStrategist`) と名前 (`name`) で検索します。

            const responseMessage = await strategistSearchCommand(search_full_name); 

            await interaction.editReply(responseMessage);

        } catch (error) {
            // ログにエラーのタイプとメッセージを必ず出力する
            console.error('軍師検索処理中にエラーが発生しました:', error.name, error.message); 
            // 詳細なエラーメッセージをユーザーに返す
            const errorMessage = `❌ 軍師検索中に予期せぬエラーが発生しました。\n\`\`\`\n${error.message.substring(0, 100)}\n\`\`\`\nログを確認してください。`;
            
            try {
                await interaction.editReply({ content: errorMessage });
            } catch (e) {
                console.error("editReplyの再試行中にエラーが発生しました:", e);
                if (interaction.channel) {
                    await interaction.channel.send({ content: `<@${interaction.user.id}> ❌ 軍師検索中に致命的なエラーが発生し、コマンドに応答できませんでした。ログを確認してください。` });
                }
            }
        }
        return;
    }
        // --- 【★ /act_record コマンドの処理 ★】 ---
    if (interaction.commandName === 'act_record') {
        // 新しいオプションを全て取得
        const myTeam = interaction.options.getString('my_team');
        const mPoint = interaction.options.getInteger('maelstrom_points');
        const tPoint = interaction.options.getInteger('twin_adders_points');
        const iPoint = interaction.options.getInteger('immortal_flames_points');
        const myKills = interaction.options.getInteger('my_kills');
        const myAssists = interaction.options.getInteger('my_assists');
        const strategistFirst = interaction.options.getString('strategist_first');
        const strategistLast = interaction.options.getString('strategist_last');
        
        try {
            // 1. 返信を遅延させる (ephemeral: true を削除し、メッセージを全員に公開)
            await interaction.deferReply(); 
            
            // 2. 添付ファイルを含むメッセージを探す (limitを10に増やして確実に見つける)
            const messages = await interaction.channel.messages.fetch({ limit: 10 }); 
            const lastMessage = messages.find(
                m => m.author.id === interaction.user.id && m.attachments.size > 0
            );

            let attachmentContent = null;
            if (lastMessage) {
                const attachment = lastMessage.attachments.first();
                if (attachment && (attachment.name.toLowerCase().endsWith('.csv') || attachment.name.toLowerCase().endsWith('.txt'))) {
                    const response = await axios.get(attachment.url);
                    attachmentContent = response.data;
                }
            }

            if (!attachmentContent) {
                // ファイルが見つからなかった場合、全員に見える形でエラーを返す
                await interaction.editReply({ content: "エラー: CSVファイルが見つかりませんでした。コマンド実行前に、CSV/TXTファイルをアップロードしてください。" });
                return;
            }

            // 3. ACTデータ処理ロジックを実行
            // 必要な引数を全て渡す
            const responseMessage = await actRecordCommand(
                interaction.user.id, 
                myTeam,
                mPoint,
                tPoint,
                iPoint,
                myKills,
                myAssists,
                attachmentContent,
                strategistFirst, 
                strategistLast
            ); 

            // 4. 結果をユーザーに返信 (オブジェクトをそのまま渡す)
            await interaction.editReply(responseMessage);

        } catch (error) {
            console.error('ACT記録処理中に発生した元のエラー:', error.name, error.message);
            console.error('スタックトレース:', error.stack);
            
            try {
                await interaction.editReply({ 
                    content: `❌ ACT記録中に予期せぬエラーが発生しました。\n\`\`\`\n${error.message.substring(0, 150)}\n\`\`\`\nログを確認してください。` 
                });
            } catch (e) {
                console.error("editReplyの再試行中にエラーが発生しました:", e);
            }
        }
        return;
    }
});    

const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Discord Bot is running and connected.');
});

app.listen(port, () => {
    console.log(`Web server listening on port ${port}`);
});

if (token === 'YOUR_ACTUAL_DISCORD_BOT_TOKEN_HERE') {
    // ユーザーがトークンを置き換えるのを忘れた場合に分かりやすい警告を出力
    console.log('--- START: Discord Login Process ---');
    console.error("重大なエラー: Discordボットトークンが設定されていません。`token`変数を実際のトークンに置き換える必要があります。");
} else {
    // ログイン処理を実行
    client.login(token)
    .then(() => {
        console.log('--- SUCCESS: Discord Login Sent ---');
    })
    .catch(error => {
        console.error('--- FATAL: Discord Login Failed ---', error);
        // ★重要: ログインに失敗した場合はプロセスを終了させ、Renderに再起動を促す
        process.exit(1); 
    });
}