// script.js

document.addEventListener('DOMContentLoaded', () => {
    console.log("App Initializing...");

    // 1. 初始化 DOM 元素
    const dom = {
        navItems: document.querySelectorAll('.nav-item'),
        viewSections: document.querySelectorAll('.view-section'),
        manual: {
            bankListContainer: document.getElementById('manual-bank-list'),
            btnAddBank: document.getElementById('btn-add-bank'),
            results: {
                grace: document.getElementById('val-grace'),
                gracePayment: document.getElementById('val-grace-payment'),
                postGracePayment: document.getElementById('val-post-grace-payment'),
                totalInterest: document.getElementById('val-total-interest'),
                totalPayment: document.getElementById('val-total-payment')
            }
        },
        inputs: {
            totalPrice: document.getElementById('input-total-price'),
            loanRatio: document.getElementById('input-loan-ratio'),
            noGrace: document.getElementById('input-no-grace')
        },
        display: {
            loanAmount: document.getElementById('display-loan-amount'),
        },
        tableBody: document.querySelector('#comparison-table tbody'),
        vizContainer: document.getElementById('d3-viz-container'),
        pdfList: document.getElementById('pdf-list'),
        pdfIframe: document.getElementById('pdf-iframe'),
        pdfPlaceholder: document.getElementById('pdf-placeholder'),
        pdfViewer: document.querySelector('.pdf-viewer'),
        closePdfBtn: document.getElementById('close-pdf-btn'),
        tableHeader: document.querySelector('.table-card .card-header h3')
    };

    // 2. 狀態管理
    let state = {
        totalPrice: window.LoanConfig.defaultValues.totalPrice, // 元
        loanRatio: window.LoanConfig.defaultValues.loanRatio * 100, // as percentage 75
        loanAmount: 0, // calculated
        activeBankId: null, // for PDF
        activeBankId: null, // for PDF
        activeBankId: null, // for PDF
        currentResults: [], // Store results for comparison table modal access
        manualResultAgg: null, // Store manual calculation results for modal access
        noGracePeriod: false // Logic toggle
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


        // 3a. 尋找最佳「補位」銀行 (Uncapped & Lowest Monthly Payment)
        // 用於當某銀行額度不足時，剩下的金額由這家銀行補足
        // 用戶傾向於更長的年限 (e.g. 40年) 以降低月付金，因此這裡選 "最低寬限期後月付" (長期負擔最低)
        const uncappedBanks = window.LoanConfig.banks.filter(b => !b.maxLoanAmount || b.maxLoanAmount >= state.loanAmount);
        let fallbackBank = null;
        if (uncappedBanks.length > 0) {
            let bestScore = Infinity;
            uncappedBanks.forEach(b => {
                const sim = calculateBankDetails(b, state.loanAmount, false); // Simulate full amount
                // Optimize for Lowest Post-Grace Payment (Long-term Affordability)
                if (sim.summary.firstPostGracePayment < bestScore) {
                    bestScore = sim.summary.firstPostGracePayment;
                    fallbackBank = b;
                }
            });
        }


        // 計算每家銀行的數據 (含聯貸/組合邏輯)
        const results = window.LoanConfig.banks.map(bank => {
            // Check if capped
            if (bank.maxLoanAmount && state.loanAmount > bank.maxLoanAmount) {
                // 需要組合貸款
                const primaryAmount = bank.maxLoanAmount;
                const gapAmount = state.loanAmount - primaryAmount;

                // 1. Primary Loan
                const primaryResult = calculateBankDetails(bank, primaryAmount, true); // is primary of combo

                // 2. Secondary Loan (Gap)
                let secondaryResult = null;
                if (fallbackBank) {
                    // Use the fallback bank for the gap
                    secondaryResult = calculateBankDetails(fallbackBank, gapAmount, false);
                } else {
                    secondaryResult = calculateBankDetails(bank, gapAmount, false);
                }

                // 3. Combine Results
                return combineResults(primaryResult, secondaryResult, gapAmount, fallbackBank);

            } else {
                // 足額，直接計算
                return calculateBankDetails(bank, state.loanAmount, false);
            }
        });

        // 4. 更新表格
        state.currentResults = results; // Save for modal
        renderTable(results);
    }



    /**
     * 組合兩個貸款計算結果
     */
    function combineResults(primary, secondary, gapAmount, secondaryBank) {
        // Summary Summation
        const totalInterest = primary.summary.totalInterest + secondary.summary.totalInterest;
        const totalPayment = primary.summary.totalPayment + secondary.summary.totalPayment;

        // 寬限期內 (假設兩者寬限期重疊，取最小或各自計算? 簡單起見各自計算首月相加)
        const firstMonthPayment = primary.summary.firstMonthPayment + secondary.summary.firstMonthPayment;

        // 寬限期後 (Post Grace)
        // 這裡比較複雜因為寬限期可能不同。
        // 我們定義 "寬限期後月付" 為：當兩者都進入本息攤還時的加總 (Max of grace periods? or just check a later month?)
        // 簡單做法：取出第 (MaxGrace + 1) 個月的付款金額
        const logicMonth = Math.max(primary.bank.gracePeriod, secondaryBank ? secondaryBank.gracePeriod : 0) * 12 + 2;
        // Find payment at logicMonth for both
        const p1 = getPaymentAtMonth(primary, logicMonth);
        const p2 = getPaymentAtMonth(secondary, logicMonth);
        const firstPostGracePayment = p1 + p2;


        return {
            bank: primary.bank,
            isCombo: true,
            secondaryBank: secondaryBank,
            gapAmount: gapAmount,
            effectivePrincipal: primary.effectivePrincipal + gapAmount, // Should equal total
            summary: {
                firstMonthPayment: firstMonthPayment,
                firstPostGracePayment: firstPostGracePayment,
                totalInterest: totalInterest,
                totalPayment: totalPayment
            }
        };
    }

    function getPaymentAtMonth(res, monthIndex) {
        if (monthIndex < res.monthlyData.length) {
            return res.monthlyData[monthIndex].payment;
        }
        return 0; // Should not happen if within 30/40 years
    }

    /**
     * 計算單一銀行的還款細節
     * @param bank 銀行物件
     * @param principal 本金
     * @param isCappedCalculation 是否為有上限的計算 (影響顯示邏輯，但在這裡純數學計算沒差)
     * @param manualTerm Optional: 手動指定年限 (for Manual Tab)
     */
    function calculateBankDetails(bank, principal, isCappedCalculation, manualTerm = null) {
        // Determine Loan Term: Use Bank Specific if longer than default, otherwise default
        let bankTerm = 0;
        if (bank.rates && bank.rates.length > 0) {
            bankTerm = bank.rates.reduce((acc, r) => acc + r.year, 0); // e.g. 40
        }

        // If manualTerm is provided, override logic
        let finalYearTerm = 0;
        if (manualTerm) {
            finalYearTerm = manualTerm;
        } else {
            const configTerm = window.LoanConfig.defaultValues.loanTermYears; // 30
            finalYearTerm = Math.max(bankTerm, configTerm);
        }

        const totalMonths = finalYearTerm * 12;

        let monthlyData = [];

        // Add Month 0
        monthlyData.push({
            month: 0,
            payment: 0,
            remaining: principal,
            cumulativePayment: 0
        });

        let remainingPrincipal = principal;
        let totalInterest = 0;
        let totalPayment = 0;
        let gracePeriodMonths = bank.gracePeriod * 12;
        if (state.noGracePeriod) {
            gracePeriodMonths = 0;
        }

        let currentRateIndex = 0;
        // Adjust rate end month based on ratio of total term if manual term differs? 
        // Or just Assume rate structure holds for specified years?
        // Usually rates are defined like "Year 1-2: x%, Year 3+: y%".
        // If user sets 40 years, Year 3+ just continues.
        // So we just use rates as defined.

        let currentRateEndMonth = getMacRateEndMonth(bank.rates, 0);

        for (let month = 1; month <= totalMonths; month++) {
            // 決定當前利率
            // If the last rate has a year limit (e.g. year 40), and user sets 50 years, 
            // valid logic is to extend the last rate.
            // My getMacRateEndMonth logic sums years from index 0 to index.

            if (month > currentRateEndMonth && currentRateIndex < bank.rates.length - 1) {
                currentRateIndex++;
                currentRateEndMonth = getMacRateEndMonth(bank.rates, currentRateIndex);
            }
            // If we run out of defined rates, we stick to the last one (currentRateIndex is at last)

            const annualRate = bank.rates[currentRateIndex].rate;
            const monthlyRate = annualRate / 100 / 12;

            let interestPayment = Math.round(remainingPrincipal * monthlyRate);
            let principalPayment = 0;
            let monthlyTotal = 0;

            if (month <= gracePeriodMonths) {
                // 寬限期: 只繳息
                monthlyTotal = interestPayment;
            } else {
                // 本息均攤
                const remainingMonths = totalMonths - month + 1;
                const pmt = Math.round((remainingPrincipal * monthlyRate * Math.pow(1 + monthlyRate, remainingMonths)) / (Math.pow(1 + monthlyRate, remainingMonths) - 1));
                monthlyTotal = pmt;
                principalPayment = monthlyTotal - interestPayment;
            }

            remainingPrincipal -= principalPayment;
            let remainingDisplay = remainingPrincipal < 0 ? 0 : remainingPrincipal;

            totalInterest += interestPayment;
            totalPayment += monthlyTotal;

            monthlyData.push({
                month: month,
                interest: interestPayment,
                principal: principalPayment,
                payment: monthlyTotal,
                remaining: remainingDisplay,
                cumulativePayment: totalPayment
            });
        }

        return {
            bank: bank,
            monthlyData: monthlyData,
            effectivePrincipal: principal,
            isCapped: isCappedCalculation, // Just a flag
            summary: {
                firstMonthPayment: monthlyData[1] ? monthlyData[1].payment : 0,
                firstPostGracePayment: monthlyData[gracePeriodMonths + 1] ? monthlyData[gracePeriodMonths + 1].payment : 0,
                totalInterest: totalInterest,
                totalPayment: totalPayment + (isCappedCalculation ? bank.fee : 0) // See logic above
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
        const minPostGrace = Math.min(...results.map(r => r.summary.firstPostGracePayment)); // New Metric
        const minTotal = Math.min(...results.map(r => r.summary.totalPayment));

        results.forEach((res, index) => {
            const tr = document.createElement('tr');

            // Badges
            let badges = '';
            // Threshold logic could be added here (e.g. within 1% of min)
            if (res.summary.firstMonthPayment === minFirstMonth) {
                badges += `<span class="badge badge-success">最低首期</span>`;
            }
            if (res.summary.firstPostGracePayment === minPostGrace) {
                // New Badge for Long Term Affordability
                badges += `<span class="badge" style="background-color: #8b5cf6; color: white; display: inline-block; margin-left: 4px;">最低月付</span>`;
            }
            if (res.summary.totalPayment === minTotal) {
                badges += `<span class="badge badge-primary">最低總額</span>`;
            }

            if (badges) {
                badges = `<div style="margin-bottom: 4px;">${badges}</div>`;
            }

            // 銀行名稱 (處理 Combo 顯示)
            let nameHtml = `${badges}<div style="font-weight: 500">${res.bank.name}</div>`;

            if (res.isCombo) {
                nameHtml += `<div style="font-size: 0.8em; color: var(--text-secondary); margin-top: 4px;">
                    組合：主約 ${res.bank.maxLoanAmount / 10000}萬 
                    ${res.secondaryBank ? `+ ${res.secondaryBank.name.split('｜')[0]} ${(res.gapAmount / 10000).toFixed(0)}萬` : '+ 額度不足'}
                </div>`;
            } else if (res.isCapped) {
                // Should not happen with new logic, but safe keep
                nameHtml += `<div style="font-size: 0.8em; color: var(--danger-color);">額度不足</div>`;
            } else {
                nameHtml += `<div style="font-size: 0.8em; color: var(--text-secondary); margin-top: 4px;">貸 ${res.effectivePrincipal / 10000} 萬 (足額)</div>`;
            }

            // 利率字串
            let rateStr = '';
            if (res.isCombo && res.secondaryBank) {
                rateStr = `主: ${res.bank.rates[0].rate}%<br>副: ${res.secondaryBank.rates[0].rate}% (混和)`;
            } else {
                rateStr = res.bank.rates.map(r => `${r.rate}% (${r.year}年)`).join('<br>');
            }

            // 寬限期內月付
            let gracePaymentStr = '-';
            // Logic: if combo, showing the combined payment
            if (res.summary.firstMonthPayment > 0) {
                gracePaymentStr = `<span class="amount-cell clickable-number" onclick="window.showDetail(${index}, 'grace_payment')">$${res.summary.firstMonthPayment.toLocaleString()}</span>`;
            }

            // 寬限期後月付 (Approx)
            // Just use the calculated one
            let postGracePaymentStr = `<span class="amount-cell clickable-number" onclick="window.showDetail(${index}, 'post_grace_payment')">$${res.summary.firstPostGracePayment.toLocaleString()}</span>`;


            tr.innerHTML = `
                <td data-label="銀行名稱">${nameHtml}</td>
                <td data-label="利率結構" style="font-size: 0.9em; color: var(--text-secondary); line-height: 1.4;">${rateStr}</td>
                <td data-label="寬限期">${state.noGracePeriod ? '0' : res.bank.gracePeriod} 年 ${state.noGracePeriod ? '<span style="font-size:0.8em;color:var(--text-secondary)">(已停用)</span>' : ''}</td>
                <td data-label="寬限期內月付">${gracePaymentStr}</td>
                <td data-label="寬限期後月付">${postGracePaymentStr}</td>
                <td data-label="總利息支出" class="amount-cell clickable-number" onclick="window.showDetail(${index}, 'total_interest')">$${res.summary.totalInterest.toLocaleString()}</td>
                <td data-label="總還款金額" class="amount-cell clickable-number" onclick="window.showDetail(${index}, 'total_payment')" style="font-weight:700; color: var(--accent-color)">$${res.summary.totalPayment.toLocaleString()}</td>
            `;
            dom.tableBody.appendChild(tr);
        });
    }

    // Modal Handler
    window.showDetail = function (index, type) {
        const res = state.currentResults[index];
        if (!res) return;

        const modal = document.getElementById('detail-modal');
        const body = document.getElementById('modal-body-content');
        if (!modal || !body) return;

        let content = '';
        let title = '';

        // Helper for currency
        const fmt = n => '$' + n.toLocaleString();
        const fmtW = n => (n / 10000).toLocaleString() + '萬';

        if (type === 'grace_payment') {
            title = '寬限期內月付金計算';
            if (res.isCombo) {
                const pAcc = res.bank.maxLoanAmount;
                const pRate = res.bank.rates[0].rate;
                const gapAcc = res.gapAmount;
                const gapRate = res.secondaryBank.rates[0].rate;

                content = `
                    <div class="calc-row"><span class="calc-label">總貸款金額</span><span class="calc-value">${fmtW(state.loanAmount)}</span></div>
                    <div class="calc-row"><span class="calc-label">計算方式</span><span class="calc-value">主約 + 補位組合</span></div>
                    
                    <div class="calc-formula">
                        <div><strong>主約部分 (${res.bank.name.split('｜')[0]})</strong></div>
                        ${fmt(pAcc)} × ${pRate}% ÷ 12 = ${fmt(Math.round(pAcc * pRate / 100 / 12))}
                        <div style="margin-top:8px;"><strong>補位部分 (${res.secondaryBank.name.split('｜')[0]})</strong></div>
                        ${fmt(gapAcc)} × ${gapRate}% ÷ 12 = ${fmt(Math.round(gapAcc * gapRate / 100 / 12))}
                        <hr style="border-top:1px dashed #475569; margin:8px 0;">
                        <div style="text-align:right; color: var(--accent-color);">合計: ${fmt(res.summary.firstMonthPayment)}</div>
                    </div>
                `;
            } else {
                const rate = res.bank.rates[0].rate;
                content = `
                    <div class="calc-row"><span class="calc-label">貸款金額</span><span class="calc-value">${fmtW(res.effectivePrincipal)}</span></div>
                    <div class="calc-row"><span class="calc-label">首年利率</span><span class="calc-value">${rate}%</span></div>
                    
                    <div class="calc-formula">
                        (貸款金額 × 年利率) ÷ 12<br>
                        ${fmt(res.effectivePrincipal)} × ${rate}% ÷ 12<br>
                        = <strong>${fmt(res.summary.firstMonthPayment)}</strong>
                    </div>
                `;
            }
        }
        else if (type === 'post_grace_payment') {
            title = '寬限期後月付金 (本息攤還)';
            // Simplified explanation for amortization
            content = `
                <div class="calc-row"><span class="calc-label">還款方式</span><span class="calc-value">本息平均攤還</span></div>
                <div class="calc-formula">
                    此金額為「本息平均攤還」試算結果。<br>
                    包含本金與利息。由於各銀行年限與利率不同，系統以寬限期結束後的首月作為比較基準。
                    ${res.isCombo ? `<br><br><strong>此為組合貸款 (主約+補位) 之加總。</strong>` : ''}
                </div>
                <div class="calc-row" style="margin-top:10px;"><span class="calc-label">您需支付</span><span class="calc-value" style="color:var(--accent-color);">${fmt(res.summary.firstPostGracePayment)}</span></div>
            `;
        }
        else if (type === 'total_interest' || type === 'total_payment') {
            title = type === 'total_interest' ? '總利息支出' : '總還款金額 (含本金)';
            let details = '';
            if (res.isCombo) {
                const pInt = res.summary.totalInterest - (res.gapAmount * res.secondaryBank.rates[0].rate * 30 / 100); // Rough estimate? No, we don't have stored split.
                // Actually we summed them in combineResults but didn't store breakdown.
                // Hard to reconstruct exact interest split without re-calc. 
                // Let's just explain the logic.
                details = `此方案為組合貸款，總金額包含<br>1. <strong>${res.bank.name.split('｜')[0]}</strong> (主約)<br>2. <strong>${res.secondaryBank.name.split('｜')[0]}</strong> (補位)<br>之全期加總。`;
            } else {
                details = `此為全期 (${Math.max(res.bank.rates.reduce((a, b) => a + b.year, 0), 30)}年) 加總結果。`;
            }

            content = `
                <div class="calc-row"><span class="calc-label">項目</span><span class="calc-value">${type === 'total_interest' ? '累積利息' : '本金 + 利息 + 手續費'}</span></div>
                <div class="calc-formula">
                    ${details}<br>
                    ${type === 'total_payment' && res.bank.fee > 0 ? `*已包含手續費 $${res.bank.fee.toLocaleString()}` : ''}
                </div>
                <div class="calc-row" style="margin-top:10px;"><span class="calc-label">總計</span><span class="calc-value" style="color:var(--accent-color);">${fmt(type === 'total_interest' ? res.summary.totalInterest : res.summary.totalPayment)}</span></div>
            `;
        }

        document.querySelector('.modal-title').textContent = title;
        body.innerHTML = content;
        modal.classList.add('active');
    };




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
                    } else if (targetId === 'manual-view') {
                        initManualView();
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
    dom.inputs.noGrace.addEventListener('change', () => {
        state.noGracePeriod = dom.inputs.noGrace.checked;
        calculateLoan();
        // Also update manual view if active? Or just call it anyway
        calculateManualDetails();
    });


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

                // Trigger Fullscreen on Mobile
                dom.pdfViewer.classList.add('active');
            });
            dom.pdfList.appendChild(li);
        });

        // Handle Close PDF on Mobile
        if (dom.closePdfBtn) {
            dom.closePdfBtn.addEventListener('click', () => {
                dom.pdfViewer.classList.remove('active');
                // Optional: reset iframe if desired, but keeping it keeps state
                // dom.pdfIframe.src = ''; 
            });
        }
    }

    // ==========================================
    // Manual View Logic (Multi-Bank Support)
    // ==========================================

    function initManualView() {
        // Init with one row if empty
        if (dom.manual.bankListContainer.children.length === 0) {
            // Default to Total Loan Amount (converted to Wan)
            const initialAmount = state.loanAmount / 10000;
            addBankRow(initialAmount);
            calculateManualDetails();
        }

        // Add Button Listener
        dom.manual.btnAddBank.onclick = () => {
            // Calculate remaining amount
            let currentSum = 0;
            const rows = dom.manual.bankListContainer.querySelectorAll('.manual-bank-row');
            rows.forEach(row => {
                const val = parseFloat(row.querySelector('.manual-loan-amount').value) || 0;
                currentSum += val;
            });

            const totalLoanWan = state.loanAmount / 10000;
            const remaining = Math.max(0, totalLoanWan - currentSum);

            addBankRow(remaining);
            calculateManualDetails();
        };
    }

    function addBankRow(initialAmount = 500) {
        const rowId = 'bank-row-' + Date.now();
        const div = document.createElement('div');
        div.className = 'manual-bank-row';
        div.dataset.id = rowId;

        // Header with Delete Button
        const header = document.createElement('div');
        header.className = 'manual-bank-header';
        header.innerHTML = `
            <span style="font-size: 0.85em; color: var(--text-secondary); font-weight: 500;">銀行方案</span>
            ${dom.manual.bankListContainer.children.length > 0 ? `<button class="btn-remove-row">移除</button>` : ''}
        `;

        // Remove handler
        const removeBtn = header.querySelector('.btn-remove-row');
        if (removeBtn) {
            removeBtn.onclick = () => {
                div.remove();
                calculateManualDetails();
            };
        }

        // Inputs Container
        const inputsDiv = document.createElement('div');
        inputsDiv.className = 'manual-inputs-container';
        inputsDiv.innerHTML = `
            <div class="manual-select-group">
                <select class="manual-bank-select">
                    <!-- Options -->
                </select>
            </div>
            <div class="manual-inputs-row">
                <div class="manual-input-group">
                    <label>金額 (萬)</label>
                    <input type="number" class="manual-loan-amount" value="${initialAmount}">
                </div>
                <div class="manual-input-group">
                    <label>年限 (年)</label>
                    <input type="number" class="manual-loan-term" value="30">
                </div>
            </div>
        `;

        // Populate Select
        const select = inputsDiv.querySelector('.manual-bank-select');
        window.LoanConfig.banks.forEach((bank, index) => {
            const opt = document.createElement('option');
            opt.value = index;
            opt.textContent = bank.name;
            select.appendChild(opt);
        });

        // Add Listeners
        const inputs = inputsDiv.querySelectorAll('input, select');
        inputs.forEach(input => {
            input.addEventListener('input', calculateManualDetails);
            input.addEventListener('change', calculateManualDetails);
        });

        div.appendChild(header);
        div.appendChild(inputsDiv);
        dom.manual.bankListContainer.appendChild(div);
    }

    function calculateManualDetails() {
        const rows = dom.manual.bankListContainer.querySelectorAll('.manual-bank-row');

        let agg = {
            loanAmount: 0,
            firstMonthPayment: 0,
            totalInterest: 0,
            totalPayment: 0,
            gracePeriods: [],
            logicPayments: [] // To calc post grace properly
        };

        let maxGrace = 0;

        // 1. Calculate each row independently
        rows.forEach(row => {
            const bankIdx = row.querySelector('.manual-bank-select').value;
            const amountVal = parseFloat(row.querySelector('.manual-loan-amount').value);
            const termVal = parseInt(row.querySelector('.manual-loan-term').value);

            if (bankIdx === '' || isNaN(amountVal) || isNaN(termVal)) return;

            const bank = window.LoanConfig.banks[bankIdx];
            const amount = amountVal * 10000;

            // Pass special flag or handle via global state logic inside calculateBankDetails? 
            // Currently calculateBankDetails accesses global state? No, it takes params.
            // Wait, calculateBankDetails DOES NOT access state.noGracePeriod inside itself in my previous chunk?
            // Ah, I added `if (state.noGracePeriod)` inside calculateBankDetails in chunk 3.
            // So default behavior works.
            const res = calculateBankDetails(bank, amount, false, termVal);

            agg.loanAmount += amount;
            agg.firstMonthPayment += res.summary.firstMonthPayment;
            agg.totalInterest += res.summary.totalInterest;
            agg.totalPayment += res.summary.totalPayment;

            const effectiveGrace = state.noGracePeriod ? 0 : bank.gracePeriod;
            agg.gracePeriods.push(effectiveGrace);
            if (effectiveGrace > maxGrace) maxGrace = effectiveGrace;

            // Store result to calculate aggregated post-grace later
            // We need access to helper `getPaymentAtMonth` or just the array
            agg.logicPayments.push(res);
        });

        // 2. Calculate Aggregated Post Grace Payment
        // Logic: Sum of payments at month = Max(Grace) * 12 + 2
        // Just like combineResults logic
        const logicMonth = maxGrace * 12 + 2;
        let aggPostGrace = 0;
        agg.logicPayments.forEach(res => {
            aggPostGrace += getPaymentAtMonth(res, logicMonth);
        });

        // 3. Render
        // Grace Period Display: if multiple differ, show Range or Max?
        // Let's show Max or "混合"
        const uniqueGrace = [...new Set(agg.gracePeriods)];
        const graceText = uniqueGrace.length > 1 ? `混合 (最大${maxGrace}年)` : `${maxGrace} 年`;


        // Store global state for modal
        state.manualResultAgg = agg;
        state.manualResultAgg.maxGrace = maxGrace; // store for reference

        const fmt = n => '$' + n.toLocaleString();

        // Render with Clickable Spans
        dom.manual.results.grace.textContent = graceText;

        dom.manual.results.gracePayment.innerHTML = `<span class="clickable-number" onclick="window.showManualDetail('grace_payment')">${fmt(agg.firstMonthPayment)}</span>`;
        dom.manual.results.postGracePayment.innerHTML = `<span class="clickable-number" onclick="window.showManualDetail('post_grace_payment')">${fmt(aggPostGrace)}</span>`;
        dom.manual.results.totalInterest.innerHTML = `<span class="clickable-number" onclick="window.showManualDetail('total_interest')">${fmt(agg.totalInterest)}</span>`;
        dom.manual.results.totalPayment.innerHTML = `<span class="clickable-number" onclick="window.showManualDetail('total_payment')">${fmt(agg.totalPayment)}</span>`;
    }

    // Manual Detail Modal Handler
    window.showManualDetail = function (type) {
        const agg = state.manualResultAgg;
        if (!agg) return;

        const modal = document.getElementById('detail-modal');
        const body = document.getElementById('modal-body-content');
        if (!modal || !body) return;

        let content = '';
        let title = '';
        const fmt = n => '$' + n.toLocaleString();
        const fmtW = n => (n / 10000).toLocaleString() + '萬';

        if (type === 'grace_payment') {
            title = '寬限期內月付金計算 (多方案加總)';
            let rowsHtml = '';
            agg.logicPayments.forEach(res => {
                const bankName = res.bank.name.split('｜')[0];
                const amount = res.effectivePrincipal;
                const rate = res.bank.rates[0].rate;
                const pmt = res.summary.firstMonthPayment;
                rowsHtml += `
                    <div style="margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px dashed #e2e8f0;">
                        <div style="font-weight:500; font-size:0.9em; color:var(--text-primary);">${bankName}</div>
                        <div style="font-size:0.85em; color:var(--text-secondary);">
                           貸款 ${fmtW(amount)} × 年利 ${rate}% ÷ 12 = <strong>${fmt(pmt)}</strong>
                        </div>
                    </div>
                 `;
            });
            content = `
                <div class="calc-row"><span class="calc-label">總貸款金額</span><span class="calc-value">${fmtW(agg.loanAmount)}</span></div>
                <div class="calc-formula" style="margin-top:10px;">
                    ${rowsHtml}
                    <div style="text-align:right; font-weight:bold; color: var(--accent-color); margin-top:5px;">合計: ${fmt(agg.firstMonthPayment)}</div>
                </div>
            `;
        } else if (type === 'post_grace_payment') {
            title = '寬限期後月付金 (最大寬限期後)';
            let rowsHtml = '';
            // Logic month is derived from maxGrace
            const logicMonth = agg.maxGrace * 12 + 2;

            agg.logicPayments.forEach(res => {
                const bankName = res.bank.name.split('｜')[0];
                const pmt = getPaymentAtMonth(res, logicMonth);
                rowsHtml += `
                    <div style="margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px dashed #e2e8f0;">
                        <div style="font-weight:500; font-size:0.9em; color:var(--text-primary);">${bankName}</div>
                        <div style="font-size:0.85em; color:var(--text-secondary);">
                           第 ${Math.ceil(logicMonth / 12)} 年月付 (本息攤還) = <strong>${fmt(pmt)}</strong>
                        </div>
                    </div>
                 `;
            });
            content = `
                <div class="calc-row"><span class="calc-label">比較基準</span><span class="calc-value">第 ${Math.ceil(logicMonth / 12)} 年 (寬限期全部結束後)</span></div>
                <div class="calc-formula" style="margin-top:10px;">
                    ${rowsHtml}
                    <div style="text-align:right; font-weight:bold; color: var(--accent-color); margin-top:5px;">合計: ${fmt(parseInt(dom.manual.results.postGracePayment.textContent.replace(/\D/g, '')))}</div>
                </div>
            `;
        } else if (type === 'total_interest' || type === 'total_payment') {
            title = type === 'total_interest' ? '總利息支出' : '總還款金額';
            let rowsHtml = '';
            agg.logicPayments.forEach(res => {
                const bankName = res.bank.name.split('｜')[0];
                const principal = res.effectivePrincipal;
                const interest = res.summary.totalInterest;
                const fee = res.bank.fee || 0;
                const total = res.summary.totalPayment;

                let details = '';
                if (type === 'total_interest') {
                    // Interest Formula
                    details = `
                        <div style="font-size:0.85em; color:var(--text-secondary);">
                            累積總還款 ${fmt(total)} - 本金 ${fmtW(principal)} - 手續費 ${fmt(fee)} = <strong>${fmt(interest)}</strong>
                        </div>
                     `;
                } else {
                    // Total Payment Formula
                    details = `
                        <div style="font-size:0.85em; color:var(--text-secondary);">
                            本金 ${fmtW(principal)} + 總利息 ${fmt(interest)} + 手續費 ${fmt(fee)} = <strong>${fmt(total)}</strong>
                        </div>
                     `;
                }

                rowsHtml += `
                    <div style="margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px dashed #e2e8f0;">
                        <div style="font-weight:500; font-size:0.9em; color:var(--text-primary); margin-bottom:2px;">${bankName}</div>
                        ${details}
                    </div>
                 `;
            });
            content = `
                <div class="calc-formula">
                    <div style="margin-bottom:8px; font-weight:500; color:var(--text-primary);">各方案計算細節：</div>
                    ${rowsHtml}
                    <div style="text-align:right; font-weight:bold; color: var(--accent-color); margin-top:8px; font-size: 1.1em;">
                        總計: ${fmt(type === 'total_interest' ? agg.totalInterest : agg.totalPayment)}
                    </div>
                </div>
            `;
        }

        document.querySelector('.modal-title').textContent = title;
        body.innerHTML = content;
        modal.classList.add('active');
    };

    // Manual Inputs Event Listeners removed as they are dynamic now


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
