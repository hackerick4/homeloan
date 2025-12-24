/**
 * 房貸計算機設定檔 (Loan Configuration)
 *
 * 修改後請重新整理網頁即可生效
 */

const LoanConfig = {
    // ======================
    // 預設全域數值
    // ======================
    defaultValues: {
        totalPrice: 18980000, // 總房價 (元)
        loanRatio: 0.75,      // 貸款成數
        loanTermYears: 30     // 預設貸款年限
    },

    // ======================
    // 銀行方案（僅首購）
    // ======================
    banks: [

        // ===== 合庫：一段式(沒優惠利率補貼) =====
        {
            id: 'bank_cooperative_1stage',
            name: '合庫銀行（公股首購）｜（未補貼）',
            filename: '合庫貸款公股只作首購.pdf',
            rates: [
                { year: 40, rate: 2.275 } // 補貼後一段式機動利率
            ],
            gracePeriod: 5,
            fee: 5000,
            maxLoanAmount: 10000000,
            description: '青年安心成家｜一段式機動利率（未補貼）'
        },
        // ===== 合庫：一段式(優惠利率補貼) =====
        {
            id: 'bank_cooperative_1stage',
            name: '合庫銀行（公股首購）｜（補貼後）',
            filename: '合庫貸款公股只作首購.pdf',
            rates: [
                { year: 3, rate: 1.775 }, // 補貼後一段式機動利率
                { year: 37, rate: 2.275 } // 補貼後一段式機動利率
            ],
            gracePeriod: 5,
            fee: 5000,
            maxLoanAmount: 10000000,
            description: '青年安心成家｜一段式機動利率（補貼後）'
        },

        // ===== 合庫：一般房貸 =====
        {
            id: 'bank_cooperative_general',
            name: '合庫銀行｜一般房貸',
            filename: '合庫貸款公股只作首購.pdf', // Using same PDF for now as user didn't specify
            rates: [
                { year: 30, rate: 2.65 }
            ],
            gracePeriod: 3, // Assuming 3 years as standard, user didn't specify
            fee: 5000, // Assuming standard fee
            description: '一般房貸方案'
        },

        // ===== 中國信託 =====
        {
            id: 'bank_china',
            name: '中國信託｜首購',
            filename: '宇雄首綻中國.pdf',
            rates: [
                { year: 30, rate: 2.50 } // i + 0.77%（目前）
            ],
            gracePeriod: 3,
            fee: 8000,
            description: '宇雄首綻｜首購方案'
        },

        // ===== 元大 =====
        {
            id: 'bank_yuanta',
            name: '元大銀行｜首購',
            filename: '宇雄首綻元大.pdf',
            rates: [
                { year: 30, rate: 2.60 } // I + 0.88% 起
            ],
            gracePeriod: 3,
            fee: 5000,
            description: '宇雄首綻｜首購方案'
        },

        // ===== 凱基 =====
        {
            id: 'bank_kgi',
            name: '凱基銀行｜首購',
            filename: '宇雄首綻凱基銀行.pdf',
            rates: [
                { year: 40, rate: 2.61 } // 方案表最低起
            ],
            gracePeriod: 3,
            fee: 5000,
            description: '宇雄首綻承購戶｜首購'
        },



        // ===== 富邦 =====
        {
            id: 'bank_fubon',
            name: '富邦人壽｜首購',
            filename: '宇雄首綻富邦.pdf',
            rates: [
                { year: 40, rate: 2.50 } // I + 0.75% 起
            ],
            gracePeriod: 3,
            fee: 6000, // 開辦費 + 鑑價費
            description: '富邦優惠房貸方案｜首購'
        }
    ]
};

// 掛載到 window 供前端使用
window.LoanConfig = LoanConfig;
