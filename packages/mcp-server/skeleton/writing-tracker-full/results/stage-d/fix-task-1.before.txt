
import React, { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Book } from "../../services/bookService";
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { CalendarDays } from "lucide-react";

interface PeriodProgressSummaryProps {
  books: Book[];
}

const PeriodProgressSummary = ({ books }: PeriodProgressSummaryProps) => {
  const [period, setPeriod] = useState<'weekly' | 'monthly'>('weekly');
  
  // Calculate time periods (last 4 weeks or 6 months)
  const getPeriods = () => {
    const currentDate = new Date();
    const periods = [];
    
    if (period === 'weekly') {
      // Generate last 4 weeks
      for (let i = 0; i < 4; i++) {
        const weekStart = new Date(currentDate);
        weekStart.setDate(currentDate.getDate() - (7 * i) - currentDate.getDay());
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        
        const formattedStart = `${weekStart.getMonth() + 1}/${weekStart.getDate()}`;
        const formattedEnd = `${weekEnd.getMonth() + 1}/${weekEnd.getDate()}`;
        
        periods.push({
          label: `Week ${4-i}: ${formattedStart} - ${formattedEnd}`,
          start: weekStart,
          end: weekEnd
        });
      }
    } else {
      // Generate last 6 months
      for (let i = 0; i < 6; i++) {
        const monthStart = new Date(currentDate.getFullYear(), currentDate.getMonth() - i, 1);
        const monthEnd = new Date(currentDate.getFullYear(), currentDate.getMonth() - i + 1, 0);
        
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const monthName = monthNames[monthStart.getMonth()];
        
        periods.push({
          label: `${monthName} ${monthStart.getFullYear()}`,
          start: monthStart,
          end: monthEnd
        });
      }
      // Reverse to have most recent month first
      periods.reverse();
    }
    
    return periods;
  };
  
  // Get period data for the summary
  const calculatePeriodData = () => {
    const periods = getPeriods();
    
    return periods.map(periodInfo => {
      // Find books updated in this period
      const booksInPeriod = books.filter(book => {
        const updateDate = new Date(book.updated_at);
        return updateDate >= periodInfo.start && updateDate <= periodInfo.end;
      });
      
      // Calculate stats
      const totalBooksInPeriod = booksInPeriod.length;
      const completedBooksInPeriod = booksInPeriod.filter(book => book.is_completed).length;
      const averageProgress = totalBooksInPeriod > 0 
        ? Math.round(booksInPeriod.reduce((sum, book) => sum + (book.progress || 0), 0) / totalBooksInPeriod) 
        : 0;
      
      return {
        period: periodInfo.label,
        totalBooks: totalBooksInPeriod,
        completedBooks: completedBooksInPeriod,
        averageProgress
      };
    });
  };
  
  const periodData = calculatePeriodData();
  
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-xl flex items-center">
          <CalendarDays className="mr-2 h-5 w-5 text-primary" />
          Progress Summary by Period
        </CardTitle>
        <CardDescription>
          Track your progress over time
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs 
          defaultValue="weekly" 
          className="w-full"
          onValueChange={(value) => setPeriod(value as 'weekly' | 'monthly')}
        >
          <TabsList className="grid w-full grid-cols-2 mb-6">
            <TabsTrigger value="weekly">Weekly</TabsTrigger>
            <TabsTrigger value="monthly">Monthly</TabsTrigger>
          </TabsList>
          
          <TabsContent value="weekly" className="mt-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Week</TableHead>
                  <TableHead>Books Updated</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead>Progress</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {periodData.map((data, index) => (
                  <TableRow key={`week-${index}`}>
                    <TableCell className="font-medium">{data.period}</TableCell>
                    <TableCell>{data.totalBooks}</TableCell>
                    <TableCell>{data.completedBooks}</TableCell>
                    <TableCell>
                      <div className="w-full max-w-xs">
                        <div className="flex justify-between text-xs mb-1">
                          <span>{data.averageProgress}%</span>
                        </div>
                        <Progress value={data.averageProgress} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TabsContent>
          
          <TabsContent value="monthly" className="mt-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead>Books Updated</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead>Progress</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {periodData.map((data, index) => (
                  <TableRow key={`month-${index}`}>
                    <TableCell className="font-medium">{data.period}</TableCell>
                    <TableCell>{data.totalBooks}</TableCell>
                    <TableCell>{data.completedBooks}</TableCell>
                    <TableCell>
                      <div className="w-full max-w-xs">
                        <div className="flex justify-between text-xs mb-1">
                          <span>{data.averageProgress}%</span>
                        </div>
                        <Progress value={data.averageProgress} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TabsContent>
        </Tabs>
        
        <div className="p-4 bg-blue-50 rounded-lg mt-6">
          <h3 className="text-lg font-medium text-blue-900">Progress Insights</h3>
          <p className="text-sm text-blue-700 mt-1">
            {period === 'weekly' 
              ? 'This weekly summary shows your progress patterns over the last month.' 
              : 'This monthly summary highlights your longer-term progress trends.'}
          </p>
          <p className="text-sm text-blue-700 mt-2">
            {periodData[0]?.averageProgress > 50 
              ? 'Great work! Your latest period shows strong progress.'
              : 'Keep pushing! Your latest period has room for improvement.'}
          </p>
        </div>
      </CardContent>
    </Card>
  );
};

export default PeriodProgressSummary;
