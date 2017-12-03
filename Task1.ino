#include<LiquidCystal.h>
LiquidCrystal lcd(7,8,9,10,11,12)
const int buttonPin=5;//up count
const int buttonPin1=6;//down count

int buttonPushCounter=0;//counts number of button pressed
int buttonState=0;//current state of button
int lastButtonState=0;//previus state of button

void setup() {
pinMode(buttonPin,INPUT);
pinMode(buttonPin1,INPUT);  

lcd.begin(16,2);
lcd.setCursor(0,1)
lcd.print("Counter: ");
}

void loop() {
buttonState = digitalRead(buttonPin);
if(buttonState!=lastButtonState) 
 {
  if(buttonState==HIGH)
   {
    buttonPushCounter++;
    lcd.serCursor(7,1);
    lcd.print(buttonPushCounter)
     if(lastButtonState==9)
     {
       buttonState=0;
     }
   }
 }
lastButtonState=buttonState;

if(buttonState!=lastButtonState) 
 {
  if(buttonState==HIGH)
   {
    buttonPushCounter--;
    lcd.serCursor(7,1);
    lcd.print(buttonPushCounter)
     if(lastButtonState==3)
     {
       buttonState=6;
     }
   }
 }
lastButtonState=buttonState;
}
