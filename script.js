// script.js

document.addEventListener('DOMContentLoaded', () => {
    console.log("App Initializing...");

    // 1. 初始化 DOM 元素
    const dom = {
        navItems: document.querySelectorAll('.nav-item'),
        viewSections: document.querySelectorAll('.view-section'),
        inputs: {
            totalPrice: document.getElementById('input-total-price'),
            loanRatio: document.getElementById('input-loan-ratio')
        },
        display: {
            loanAmount: document.getElementById('display-loan-amount'),
        },
        tableBody: document.querySelector('#comparison-table tbody'),
        tableBody: document.querySelector('#comparison-table tbody'),
        pdfList: document.getElementById('pdf-list'),
        pdfIframe: document.getElementById('pdf-iframe'),
        pdfPlaceholder: document.getElementById('pdf-placeholder'),
        tableHeader: document.querySelector('.table-card .card-header h3') // For debug info
    };

    // 2. 狀態管理
    let state = {
        totalPrice: window.LoanConfig.defaultValues.totalPrice, // 元
        loanRatio: window.LoanConfig.defaultValues.loanRatio * 100, // as percentage 75
        loanAmount: 0, // calculated
        totalPrice: window.LoanConfig.defaultValues.totalPrice, // 元
        loanRatio: window.LoanConfig.defaultValues.loanRatio * 100, // as percentage 75
        loanAmount: 0, // calculated
        activeBankId: null, // for PDF
    };

    // 3. 核心計算邏輯
    function calculateLoan() {
        console.log("Calculating Loan...");
        // 計算貸款總額
        state.loanAmount = Math.floor(state.totalPrice * (state.loanRatio / 100));

        // 更新顯示
        dom.display.loanAmount.textContent = (state.loanAmount / 10000).toLocaleString('zh-TW', { maximumFractionDigits: 1 });

        if (!window.LoanConfig.banks || window.LoanConfig.banks.length === 0) {
            console.error("No banks found in Config!");
            dom.tableHeader.textContent = "銀行方案 (Error: 無資料)";
            return;
        }

        // Debug info
        dom.tableHeader.textContent = `銀行方案詳細數據比較 (共 ${window.LoanConfig.banks.length} 筆)`;

        // 計算每家銀行的數據
        const results = window.LoanConfig.banks.map(bank => {
            return calculateBankDetails(bank, state.loanAmount);
        });

        // 更新表格
        renderTable(results);

        // 更新表格
        renderTable(results);
    }

    /**
     * 計算單一銀行的還款細節
     */
    function calculateBankDetails(bank, globalPrincipal) {
        // 處理最大貸款額度限制
        let effectivePrincipal = globalPrincipal;
        let isCapped = false;

        if (bank.maxLoanAmount && globalPrincipal > bank.maxLoanAmount) {
            effectivePrincipal = bank.maxLoanAmount;
            isCapped = true;
        }

        const totalMonths = window.LoanConfig.defaultValues.loanTermYears * 12;
        let monthlyData = [];

        // Add Month 0 point (Initial State)
        monthlyData.push({
            month: 0,
            year: 0,
            interest: 0,
            principal: 0,
            payment: 0,
            remaining: effectivePrincipal,
            cumulativePayment: 0
        });

        let remainingPrincipal = effectivePrincipal;
        let totalInterest = 0;
        let totalPayment = 0;
        let gracePeriodMonths = bank.gracePeriod * 12;

        let currentRateIndex = 0;
        let currentRateEndMonth = getMacRateEndMonth(bank.rates, 0);

        for (let month = 1; month <= totalMonths; month++) {
            // 決定當前利率
            if (month > currentRateEndMonth && currentRateIndex < bank.rates.length - 1) {
                currentRateIndex++;
                currentRateEndMonth = getMacRateEndMonth(bank.rates, currentRateIndex);
            }
            const annualRate = bank.rates[currentRateIndex].rate;
            const monthlyRate = annualRate / 100 / 12;

            let interestPayment = Math.round(remainingPrincipal * monthlyRate);
            let principalPayment = 0;
            let monthlyTotal = 0;

            if (month <= gracePeriodMonths) {
                // 寬限期: 只繳息
                monthlyTotal = interestPayment;
            } else {
                // 本息均攤: 計算剩餘期數的月付金
                const remainingMonths = totalMonths - month + 1;
                // PMT 公式
                const pmt = Math.round((remainingPrincipal * monthlyRate * Math.pow(1 + monthlyRate, remainingMonths)) / (Math.pow(1 + monthlyRate, remainingMonths) - 1));

                monthlyTotal = pmt;
                principalPayment = monthlyTotal - interestPayment;
            }

            // 更新累積與剩餘
            remainingPrincipal -= principalPayment;
            let remainingDisplay = remainingPrincipal < 0 ? 0 : remainingPrincipal; // Clamp display

            totalInterest += interestPayment;
            totalPayment += monthlyTotal;

            monthlyData.push({
                month: month,
                year: Math.ceil(month / 12),
                interest: interestPayment,
                principal: principalPayment,
                payment: monthlyTotal,
                remaining: remainingDisplay,
                cumulativePayment: totalPayment,
                cumulativeInterest: totalInterest
            });

            // Sync remaining principal for next iteration calculation
            // remainingPrincipal is already updated
        }

        return {
            bank: bank,
            monthlyData: monthlyData, // Now includes month 0
            effectivePrincipal: effectivePrincipal,
            isCapped: isCapped,
            summary: {
                // First month payment is at index 1 now (index 0 is origin)
                firstMonthPayment: monthlyData[1] ? monthlyData[1].payment : 0,
                // Post grace payment logic
                firstPostGracePayment: monthlyData[gracePeriodMonths + 1] ? monthlyData[gracePeriodMonths + 1].payment : 0,
                totalInterest: totalInterest,
                totalPayment: totalPayment + bank.fee // 包含手續費
            }
        };
    }

    function getMacRateEndMonth(rates, index) {
        let totalYears = 0;
        for (let i = 0; i <= index; i++) {
            totalYears += rates[i].year;
        }
        return totalYears * 12;
    }

    // 4. 表格渲染
    function renderTable(results) {

        dom.tableBody.innerHTML = '';

        // Algorithm: Find Min Values for Recommendation
        const minFirstMonth = Math.min(...results.map(r => r.summary.firstMonthPayment));
        const minTotal = Math.min(...results.map(r => r.summary.totalPayment));

        results.forEach(res => {
            const tr = document.createElement('tr');

            // Badges
            let badges = '';
            // Only show lowest monthly if it's statistically significant or distinct? 
            // For now, simple min check.
            if (res.summary.firstMonthPayment === minFirstMonth) {
                badges += `<span class="badge badge-success">最低首期</span>`;
            }
            if (res.summary.totalPayment === minTotal) {
                badges += `<span class="badge badge-primary">最低總額</span>`;
            }

            if (badges) {
                badges = `<div style="margin-bottom: 4px;">${badges}</div>`;
            }

            // 銀行名稱 (含 Cap 提示)
            let nameHtml = `${badges}<div style="font-weight: 500">${res.bank.name}</div>`;
            if (res.isCapped) {
                nameHtml += `<div style="font-size: 0.8em; color: var(--danger-color); margin-top: 4px;">注意：上限 ${res.effectivePrincipal / 10000} 萬</div>`;
                nameHtml += `<div style="font-size: 0.75em; color: var(--text-secondary);">(僅計算額度內金額)</div>`;
            } else {
                nameHtml += `<div style="font-size: 0.8em; color: var(--text-secondary); margin-top: 4px;">貸 ${res.effectivePrincipal / 10000} 萬</div>`;
            }

            // 利率字串
            const rateStr = res.bank.rates.map(r => `${r.rate}% (${r.year}年)`).join('<br>');

            // 寬限期內月付
            let gracePaymentStr = '-';
            if (res.bank.gracePeriod > 0) {
                gracePaymentStr = `<span class="amount-cell">$${res.summary.firstMonthPayment.toLocaleString()}</span>`;
            }

            // 寬限期後月付
            const postGracePayment = res.bank.gracePeriod > 0 ? res.summary.firstPostGracePayment : res.summary.firstMonthPayment;
            let postGracePaymentStr = `<span class="amount-cell">$${postGracePayment.toLocaleString()}</span>`;

            tr.innerHTML = `
                <td>${nameHtml}</td>
                <td style="font-size: 0.9em; color: var(--text-secondary); line-height: 1.4;">${rateStr}</td>
                <td>${res.bank.gracePeriod} 年</td>
                <td>${gracePaymentStr}</td>
                <td>${postGracePaymentStr}</td>
                <td class="amount-cell">$${res.summary.totalInterest.toLocaleString()}</td>
                <td class="amount-cell" style="font-weight:700; color: var(--accent-color)">$${res.summary.totalPayment.toLocaleString()}</td>
            `;
            dom.tableBody.appendChild(tr);
        });
    }



    // 自定義 Axis Format 如果需要
    d3.init = function () {
        // init helpers...
    }

    // 6. 事件監聽
    // Navigation
    dom.navItems.forEach(item => {
        item.addEventListener('click', () => {
            dom.navItems.forEach(n => n.classList.remove('active'));
            dom.viewSections.forEach(v => {
                v.style.display = 'none';
                v.classList.remove('active');
            });
            item.classList.add('active');
            const targetId = item.dataset.target;
            const targetEl = document.getElementById(targetId);
            if (targetEl) {
                targetEl.style.display = 'block';
                setTimeout(() => {
                    targetEl.classList.add('active');
                    // Resize chart if switching to calculator view
                    if (targetId === 'calculator-view') {
                        calculateLoan();
                    }
                }, 10);
            }
        });
    });

    // Inputs
    const updateHandler = () => {
        state.totalPrice = parseFloat(dom.inputs.totalPrice.value) * 10000; // 萬 -> 元
        state.loanRatio = parseFloat(dom.inputs.loanRatio.value);
        if (isNaN(state.totalPrice) || isNaN(state.loanRatio)) return;
        calculateLoan();
    };

    dom.inputs.totalPrice.addEventListener('input', updateHandler);
    dom.inputs.loanRatio.addEventListener('input', updateHandler);



    // Init PDF List
    function initPdfList() {
        if (!window.LoanConfig.banks) return;
        dom.pdfList.innerHTML = ''; // Clear
        window.LoanConfig.banks.forEach(bank => {
            const li = document.createElement('li');
            li.textContent = bank.name;
            li.addEventListener('click', () => {
                Array.from(dom.pdfList.children).forEach(c => c.classList.remove('active'));
                li.classList.add('active');
                const pdfPath = `doc/${bank.filename}#toolbar=0&navpanes=0&scrollbar=0`;
                dom.pdfIframe.src = pdfPath;
                dom.pdfIframe.style.display = 'block';
                dom.pdfPlaceholder.style.display = 'none';
            });
            dom.pdfList.appendChild(li);
        });
    }

    // 7. 啟動
    function init() {
        // Set Default Inputs
        dom.inputs.totalPrice.value = state.totalPrice / 10000;
        dom.inputs.loanRatio.value = 75; // Explicit default

        initPdfList();
        calculateLoan();

        window.addEventListener('resize', calculateLoan);
    }

    init();
});
